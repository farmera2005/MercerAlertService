# secrets/ (optional)

Not committed (see `.gitignore`). **Not needed for a normal install**: the `init` container
generates the bootstrap secrets, and everything else is entered in the web UI, where secrets
are stored encrypted.

Use this folder only if you prefer files over the web UI, for example to mount an Orion CA
certificate with a `docker-compose.override.yml`:

```yaml
services:
  worker:
    volumes: ['./secrets:/run/mas-secrets:ro']
    environment:
      SWIS_CA_CERT_PATH: /run/mas-secrets/orion-ca.pem
```

It is also where you can put `corp-ca.pem` for `BUILD_CA_FILE` when building behind a
TLS-inspecting proxy.
