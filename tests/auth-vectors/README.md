# Token test vectors

The goal is one set of tokens that both verifiers must judge the same way: the workflow
endpoint (Python, `packages/core/canyonos_core/auth.py`) and the dashboard API
(TypeScript). Each suite trusts `vectors.pub` and sends every token in `vectors.json`.

- `vectors.pub`: the public half of the throwaway key that signed the vectors. Its private
  half was deleted once they were made, so nobody can sign a new token with it.
- `vectors.json`: a list of `{name, token, expect}`. `expect` holds one verdict per
  verifier, `{endpoint: {status, code?}, api: {status, code?}}`:
  - `endpoint` is the answer to `GET /status/nothing` with the token as the bearer. A
    token the endpoint accepts gets the route's own `404`, with no `code`.
  - `api` is the answer to `GET /projects`.
  - `code` is the refusal's name: the endpoint's `error_name`, the API's `error`.

## What each vector checks

Most malformed tokens carry `aud: ["*", "canyonos-api"]`, so both verifiers accept the
audience and the one defect the vector names is what refuses it.

| Name                     | Token                                                     | Endpoint | API |
| ------------------------ | --------------------------------------------------------- | -------- | --- |
| `all-projects-query`     | `query`, `aud: ["*"]`                                     | 404      | 401 |
| `expired`                | `query`, expired a minute ago                             | 401      | 401 |
| `wrong-aud`              | `query` for another project                               | 401      | 401 |
| `scope-write-aud-api`    | `write`, `aud: ["canyonos-api"]`                          | 401      | 403 |
| `no-aud`                 | no `aud`                                                  | 401      | 401 |
| `wrong-iss`              | `iss: "someone-else"`                                     | 401      | 401 |
| `no-scope`               | no `scope`                                                | 401      | 401 |
| `alg-none`               | `alg: none`, no signature                                 | 401      | 401 |
| `hs256`                  | `alg: HS256`, keyed with `vectors.pub`'s PEM              | 401      | 401 |
| `two-scopes`             | `scope: "query read"`                                     | 401      | 401 |
| `scope-read-aud-project` | `read`, `aud: ["*"]`                                      | 403      | 401 |
| `scope-query-aud-api`    | `query`, `aud: ["canyonos-api"]`                          | 401      | 403 |
| `aud-int`                | `aud: 5`                                                  | 401      | 401 |
| `aud-bool`               | `aud: true`                                               | 401      | 401 |
| `wrong-aud-bad-jti`      | another project's `aud` and `jti: 5`                      | 401      | 401 |
| `wrong-aud-bad-sub`      | another project's `aud` and `sub: 5`                      | 401      | 401 |
| `scope-padded`           | `scope: " query"`                                         | 401      | 401 |
| `scope-unknown`          | `scope: "admin"`                                          | 401      | 401 |
| `iat-future`             | `query`, `aud: ["*", "canyonos-api"]`, `iat` in 2100      | 404      | 403 |

Every 401 is `auth.invalid_token`, and every 403 is `auth.insufficient_scope`.

Neither verifier checks `iat`, so a signer whose clock runs ahead is accepted at both
(`iat-future`), and both give `exp` 60 seconds of leeway for clock skew.

## How they were made

1. Make a throwaway key outside `~/.canyonos`:

   ```bash
   canyonos keys create --name vectors --auth-dir /tmp/vectors
   ```

2. Sign the tokens the CLI can make. Each command writes only the token to stdout:

   ```bash
   canyonos token create --auth-dir /tmp/vectors --scope query --all-projects          # all-projects-query
   canyonos token create --auth-dir /tmp/vectors --scope query \
     --project 00000000-0000-4000-8000-000000000000                                     # wrong-aud
   canyonos token create --auth-dir /tmp/vectors --scope write                         # scope-write-aud-api
   ```

3. Sign the malformed ones with PyJWT and the same private key. The CLI refuses to make
   them. `expired` is signed with `exp` a minute in the past, so it reaches both
   verifiers' expiry check, which a CLI token with `--ttl` could not: its audience is
   either the projects or the API, never both. `iat-future` is signed with `iat`
   2100-01-01T00:00:00Z, so it stays in the future. `alg-none` and `hs256` are put
   together by hand:
   - `alg-none`: the header and claims, base64url, joined by `.`, with an empty signature.
   - `hs256`: the same, with an HMAC-SHA256 signature keyed with the bytes of
     `vectors.pub`. This is the algorithm-confusion attack.

   ```python
   import time, uuid, jwt

   private = open("/tmp/vectors/vectors.key").read()

   def claims(**extra):
       base = {"iss": "canyonos", "iat": int(time.time()), "jti": uuid.uuid4().hex}
       return {k: v for k, v in {**base, **extra}.items() if v is not None}

   jwt.encode(claims(aud=["*", "canyonos-api"], scope="query read"), private, algorithm="EdDSA")
   ```

4. Copy `/tmp/vectors/trusted/vectors.pub` here, write the tokens into `vectors.json`,
   and delete `/tmp/vectors`, private key included.

To add a vector, make a new throwaway key and sign every vector again with it: the old
private key is gone.
