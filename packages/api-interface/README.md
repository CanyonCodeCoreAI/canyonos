# canyonos-api-interface

Typed clients for the CanyonOS REST API (`/v1`), for TypeScript and Python.

A deploy's address and headers are in `~/.canyonos/deployments/<workflow group>/state.json`: the API is on `http://127.0.0.1:<port>`, and every request sends its `headers`.

## TypeScript

```sh
npm install @canyoncode/canyonos-api-interface
```

```ts
import { createClient } from '@canyoncode/canyonos-api-interface';

const api = createClient('http://127.0.0.1:8000', { Authorization: 'Bearer <secret>' });
const { data, error } = await api.GET('/v1/workflow-groups/{workflow_group_id}', {
  params: { path: { workflow_group_id: '<workflow_group_id>' } },
});
```

## Python

```sh
pip install canyonos-api-interface
```

```python
from canyonos_api_interface.client import Client

api = Client("http://127.0.0.1:8000", {"Authorization": "Bearer <secret>"})
status = api.status("<workflow_group_id>")
print(status.phase)
```

An error answer raises `urllib.error.HTTPError`, with an `Error` as its body.

## Versions

Each change to the API's shapes publishes a new `1.0.x` of both packages. A breaking change moves the API to `/v2` and the packages to a new major version.
