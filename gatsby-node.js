const Git = require("simple-git/promise");
const fastGlob = require("fast-glob");
const fs = require("fs");
const { createFileNode } = require("gatsby-source-filesystem/create-file-node");
const GitUrlParse = require("git-url-parse");

async function isAlreadyCloned(remote, path) {
  const existingRemote = await Git(path).listRemote(["--get-url"]);
  return existingRemote.trim() == remote.trim();
}

async function getTargetBranch(repo, branch) {
  if (typeof branch !== `string`) {
    // Find either the branch name or HEAD if in detached head.
    branch = (await repo.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  if (branch === "HEAD") {
    // Detached head has no branch
    return branch;
  }

  // Turn 'branch' into 'origin/branch' (or whatever it's tracking)
  return repo.raw(["rev-parse", "--symbolic-full-name", "--abbrev-ref", `${branch}@{u}`]).then( x => x.trim() );
}

async function parseContributors(repo, path) {
  let args = ['shortlog', '-n', '-s', '-e', 'HEAD'];
  if (path) {
    args.push('--', path);
  }
  // shortlog may return undefined if the file hasn't been committed (in which case,
  // there are no contributors to be had)
  return repo.raw(args).then(result => (result || '').trim().split('\n').map(x => {
    let items = x.trim().split(/\s*(\d+)\s+(.+?)\s+<([^>]+)>\s*/g).slice(1, -1);
    return {
      count: parseInt(items[0]),
      name: items[1],
      email: items[2]
    };
  }));
}

async function getLog(repo, path, {pretty, count = 1}) {
  const args = ['log'];
  if( count > 0 ) {
    args.push(`-${count}`);
  }
  if( pretty ) {
    args.push(`--pretty=${pretty}`);
  }
  args.push('--');
  args.push(path);
  return repo.raw(args).then( x => x.trim() );
}

async function getRepo(path, remote, branch, depth) {
  // If the directory doesn't exist or is empty, clone. This will be the case if
  // our config has changed because Gatsby trashes the cache dir automatically
  // in that case.
  if (!fs.existsSync(path) || fs.readdirSync(path).length === 0) {
    let opts = [];
    if ( depth && depth !== 'all' ) {
      opts.push(`--depth`, depth);
    }
    if (typeof branch == `string`) {
      opts.push(`--branch`, branch);
    }
    await Git().clone(remote, path, opts);
    return Git(path);
  } else if (await isAlreadyCloned(remote, path)) {
    const repo = await Git(path);
    const target = await getTargetBranch(repo, branch);
    if (target !== "HEAD") {
      // Refresh our shallow clone with the latest commit.
      if( depth && depth !== 'all' ) {
        await repo.fetch([`--depth`, depth]);
      } else {
        await repo.fetch();
      }
      await repo.reset([`--hard`, target]);
    }
    return repo;
  } else {
    throw new Error(`Can't clone to target destination: ${path}`);
  }
}

exports.sourceNodes = async (
  {
    actions: { createNode },
    store,
    createNodeId,
    createContentDigest,
    reporter
  },
  {
    name,
    remote,
    branch,
    patterns = `**`,
    local,
    depth = 1,
    contributors,
    log
}) => {
  const programDir = store.getState().program.directory;
  const localPath = local || require("path").join(
    programDir,
    `.cache`,
    `gatsby-source-git`,
    name
  );
  const parsedRemote = GitUrlParse(remote);

  let repo;
  try {
    repo = await getRepo(localPath, remote, branch, depth);
  } catch (e) {
    return reporter.error(e);
  }

  parsedRemote.git_suffix = false;
  parsedRemote.webLink = parsedRemote.toString("https");
  delete parsedRemote.git_suffix;
  let ref = await repo.raw(["rev-parse", "--abbrev-ref", "HEAD"]);
  parsedRemote.ref = ref.trim();

  const repoFiles = await fastGlob(patterns, {
    cwd: localPath,
    absolute: true
  });

  const remoteId = createNodeId(`git-remote-${name}`);

  let repoContributors = undefined;
  if (contributors && (contributors == 'all' || contributors === 'repo')) {
    repoContributors = {
      gitContributors: await parseContributors(repo)
    };
  }
  const wantFileContributors = contributors && (contributors == 'all' || contributors == 'path');

  // Create a single graph node for this git remote.
  // Filenodes sourced from it will get a field pointing back to it.
  await createNode(
    Object.assign(parsedRemote, {
      id: remoteId,
      sourceInstanceName: name,
      parent: null,
      children: [],
      internal: {
        type: `GitRemote`,
        content: JSON.stringify(parsedRemote),
        contentDigest: createContentDigest(parsedRemote)
      }
    }, repoContributors)
  );

  const createAndProcessNode = async path => {
    let fileNode = await createFileNode(path, createNodeId, {
      name: name,
      path: localPath
    });

    // Add contributors if requested.
    if (wantFileContributors) {
      fileNode.gitContributors = await parseContributors(repo, path);
    }

    if (log) {
      fileNode.gitLog = await getLog(repo, path, log);
    }

    // Add a link to the git remote node
    fileNode.gitRemote___NODE = remoteId;

    // Then create the node, as if it were created by the gatsby-source
    // filesystem plugin.
    return createNode(fileNode, {
      name: `gatsby-source-filesystem`
    });
  };

  return Promise.all(repoFiles.map(createAndProcessNode));
};

exports.onCreateNode;
