# canyonos-sdk

A typed TypeScript client for the CanyonOS REST API (`/v1`).

On Docker the API is the dashboard's, on `http://127.0.0.1:3000` unless that port was
taken, and every request sends the control key in `~/.canyonos/control_key`.

```sh
npm install @canyoncode/canyonos-sdk
```

```ts
import { createClient } from '@canyoncode/canyonos-sdk';

const api = createClient('http://127.0.0.1:3000', { Authorization: 'Bearer <control key>' });
const { data, error } = await api.GET('/v1/workflow-groups/{workflow_group_id}', {
  params: { path: { workflow_group_id: '<workflow_group_id>' } },
});
```

`src/schema.ts` is generated from `packages/api/openapi.json`. After changing a `/v1`
route, run `bun run sdk:generate` from the repository root: it writes the spec, this
client's types and the CLI's types in `packages/cli/canyonos/sdk/models.py`.

## Versions

Each change to the API's shapes publishes a new `1.0.x`. A breaking change moves the API to `/v2` and the package to a new major version.
