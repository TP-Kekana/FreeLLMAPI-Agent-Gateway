# FreeLLMAPI Agent Gateway

An isolated deployment project for a self-hosted FreeLLMAPI core and four separately authenticated OpenAI-compatible APIs:

| Consumer | Base URL | Default model environment variable |
| --- | --- | --- |
| Worker | `https://HOST/worker/v1` | `WORKER_MODEL` |
| Planner | `https://HOST/planner/v1` | `PLANNER_MODEL` |
| Manager | `https://HOST/manager/v1` | `MANAGER_MODEL` |
| UI | `https://HOST/ui/v1` | `UI_MODEL` |

Each route requires its own bearer token. The public role gateway never exposes the FreeLLMAPI dashboard, provider keys, encryption key, or unified upstream key. The FreeLLMAPI container stays on an internal Docker network.

## Architecture

1. The role gateway authenticates the role-specific bearer key.
2. Requests with `model: auto` are rewritten to that role's configured model or named chain.
3. The request is forwarded to the internal FreeLLMAPI OpenAI-compatible API.
4. Streaming and non-streaming responses are relayed without buffering the upstream response.
5. Watchtower checks Docker Hub every five minutes and replaces only this project's labelled gateway container after CI publishes a new image.

## Local verification

```bash
npm test
npm run check
docker build -t freellmapi-role-gateway:test .
```

## GitHub and Docker Hub CI/CD

The `docker-publish.yml` workflow builds `linux/amd64` and `linux/arm64`, produces SBOM/provenance attestations, and publishes immutable SHA tags plus `latest` to `thulanekekana/freellmapi-agent-gateway`.

Configure these GitHub Actions secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Never commit provider keys, the FreeLLMAPI unified key, role keys, or the encryption key.

## Hostinger deployment

Use `compose.hostinger.yml` as a new Docker Manager application. Keep this stack separate from `nextgen-ai`. The compose file expects secrets in Docker Manager environment variables and routes only the role gateway through the VPS Traefik instance.

`compose.hostinger.external.yml` is the zero-downtime migration variant. It deploys only the role gateway and forwards to an already configured FreeLLMAPI installation. This lets consumers move to isolated role routes before provider credentials are migrated into the new internal core. The stack joins the existing Traefik network and remains separate from every NextGen-AI container and volume.

After the first FreeLLMAPI start, retrieve its generated unified key from the internal core logs or its protected Keys page and set `FREELLMAPI_UNIFIED_KEY`. Then restart the role gateway. Add provider keys through the FreeLLMAPI admin surface from a private tunnel or local-only port; do not expose the admin dashboard publicly.

## Railway integration

Configure the NextGen-AI services with role-specific base URLs and keys:

```text
NEXTGEN_LLM_WORKER_BASE_URL=https://HOST/worker/v1
NEXTGEN_LLM_WORKER_API_KEY=...
NEXTGEN_LLM_PLANNER_BASE_URL=https://HOST/planner/v1
NEXTGEN_LLM_PLANNER_API_KEY=...
NEXTGEN_LLM_MANAGER_BASE_URL=https://HOST/manager/v1
NEXTGEN_LLM_MANAGER_API_KEY=...
NEXTGEN_LLM_UI_BASE_URL=https://HOST/ui/v1
NEXTGEN_LLM_UI_API_KEY=...
```

Until the application consumes role-specific variables, retain the existing `NEXTGEN_LLM_BASE_URL` and `NEXTGEN_LLM_API_KEY` as a compatibility path.

## Upstream

This deployment uses the official MIT-licensed FreeLLMAPI image from [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi). Free-tier availability and quotas are controlled by upstream providers and can change; no fixed monthly token amount is guaranteed by this wrapper.
