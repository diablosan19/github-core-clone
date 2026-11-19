# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/diablosan19/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/diablosan19/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in TypeScript on the Node standard library alone: git smart HTTP
(clone, fetch with shallow/deepen, push with report-status, protocol v0 and v2), the REST v3
surface (repositories, branches, commits, contents, labels, issues, comments, pull requests with
squash merges), a GraphQL v4 endpoint covering the documents gh actually sends, and an MCP
endpoint whose tools act on the same store. One in-memory object model backs every surface, so
an issue opened over MCP is the same object REST reads and GraphQL numbers.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zesty-tapir-35&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
