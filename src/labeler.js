import * as core from "@actions/core";
import * as github from "@actions/github";
import * as yaml from "js-yaml";
import { Minimatch } from "minimatch";

export async function run() {
  try {
    const token = core.getInput("repo-token", { required: true });
    const configPath = core.getInput("configuration-path", { required: true });
    const syncLabels = !!core.getInput("sync-labels", { required: false });

    const prNumber = getPrNumber();
    if (!prNumber) {
      console.log("Could not get pull request number from context, exiting");
      return;
    }

    const client = new github.GitHub(token);

    const { data: pullRequest } = await client.pulls.get({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });

    core.debug(`fetching changed files for pr #${prNumber}`);
    const changedFiles = await getChangedFiles(client, prNumber);
    const labelGlobs = await getLabelGlobs(
      client,
      configPath
    );

    const labels = [];
    const labelsToRemove = [];
    for (const [label, globs] of labelGlobs.entries()) {
      core.debug(`processing ${label}`);
      if (allFilesMatch(changedFiles, globs)) {
        labels.push(label);
      } else if (pullRequest.labels.find((l) => l.name === label)) {
        labelsToRemove.push(label);
      }
    }

    if (labels.length > 0) {
      await addLabels(client, prNumber, labels);
    }

    if (syncLabels && labelsToRemove.length) {
      await removeLabels(client, prNumber, labelsToRemove);
    }
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function getPrNumber() {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return undefined;
  }

  return pullRequest.number;
}

async function getChangedFiles(
  client,
  prNumber
) {
  const listFilesOptions = client.pulls.listFiles.endpoint.merge({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
  });

  const listFilesResponse = await client.paginate(listFilesOptions);
  const changedFiles = listFilesResponse.map((f) => f.filename);

  core.debug("found changed files:");
  for (const file of changedFiles) {
    core.debug("  " + file);
  }

  return changedFiles;
}

async function getLabelGlobs(
  client,
  configurationPath
) {
  const configurationContent = await fetchContent(
    client,
    configurationPath
  );

  // loads (hopefully) a `{[label:string]: string | StringOrMatchConfig[]}`, but is `any`:
  const configObject = yaml.safeLoad(configurationContent);

  // transform `any` => `Map<string,StringOrMatchConfig[]>` or throw if yaml is malformed:
  return getLabelGlobMapFromObject(configObject);
}

async function fetchContent(
  client,
  repoPath
) {
  const response = await client.repos.getContents({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha,
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getLabelGlobMapFromObject(
  configObject
) {
  const labelGlobs = new Map();
  for (const label in configObject) {
    if (typeof configObject[label] === "string") {
      labelGlobs.set(label, [configObject[label]]);
    } else if (configObject[label] instanceof Array) {
      labelGlobs.set(label, configObject[label]);
    } else {
      throw Error(
        `found unexpected type for label ${label} (should be string or array of globs)`
      );
    }
  }

  return labelGlobs;
}

function printPattern(matcher) {
  return (matcher.negate ? "!" : "") + matcher.pattern;
}

export function allFilesMatch(
  changedFiles,
  globs
) {
  const matchers = globs.map((g) => new Minimatch(g));

  for (const changedFile of changedFiles) {
    
    if (!isMatch(changedFile, matchers)) {
      return false
    }
  }
  console.log('called true')

  return true;
}

function isMatch(changedFile, matchers) {
  core.debug(`    matching patterns against file ${changedFile}`);
  for (const matcher of matchers) {
    core.debug(`   - ${printPattern(matcher)}`);

    console.log(changedFile)
    console.log(matcher.match(changedFile))
    
    if (matcher.match(changedFile)) {
      return true;
    }
  }

  core.debug(`   all patterns matched`);
  return false;
}


async function addLabels(
  client,
  prNumber,
  labels
) {
  await client.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: labels,
  });
}

async function removeLabels(
  client,
  prNumber,
  labels
) {
  await Promise.all(
    labels.map((label) =>
      client.issues.removeLabel({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: prNumber,
        name: label,
      })
    )
  );
}

