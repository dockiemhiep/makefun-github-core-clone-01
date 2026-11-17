# Make.fun GitHub core clone

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/dockiemhiep/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/dockiemhiep/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A dependency-free, in-memory GitHub-compatible forge for the
[github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01). It implements the
sealed suite's Git smart HTTP, REST v3, GraphQL v4, and MCP surfaces with native Node.js code.

## Run

Node 22.18 or later is required. The bounty harness supplies `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN`.

```sh
npm start
```

The entry binds an ephemeral port, registers it with the make.fun environment, serves all protocol
surfaces from one process, and exits only when the environment reports that grading is complete.

## Implementation

- Native Git object, packfile, pkt-line, upload-pack v2, and receive-pack support
- In-memory repositories, refs, commits, contents, issues, comments, labels, and pull requests
- GitHub-compatible REST and GraphQL responses for the suite's client operations
- Streamable HTTP MCP discovery plus six repository, issue, and pull-request tools
- No runtime packages, subprocesses, filesystem state, model calls, or outbound network access

See [NOTES.md](NOTES.md) for the local conformance and performance record.

## License

MIT
