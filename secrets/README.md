# secrets/

Not committed (see `.gitignore`). Mounted read-only into the containers at `/run/mas-secrets`.

| File            | Used by | Notes                                                                                                  |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `orion-ca.pem`  | worker  | Orion's certificate (or its issuing CA) in PEM. Set `SWIS_CA_CERT_PATH=/run/mas-secrets/orion-ca.pem`. |
| `swis_password` | worker  | Optional alternative to `SWIS_PASSWORD`: set `SWIS_PASSWORD_FILE=/run/mas-secrets/swis_password`.      |

Any secret variable `X` can be supplied as a file with `X_FILE=/run/mas-secrets/<file>`.
