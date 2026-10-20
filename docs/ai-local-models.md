# Local AI models for room-planning drafts

This is optional setup for the [local AI companion](ai-planning.md). The
recommended [Home Assistant workflow](home-assistant-editor.md) installs, draws,
and publishes without a local model, Python setup, or inference service.

**Implemented local profiles; runtime/model setup remains your choice.** Official
sources checked 2026-10-16. Home Studio supports Ollama's native Chat API and the
OpenAI-compatible Chat Completions APIs of LM Studio, llama.cpp, vLLM and LocalAI.
The examples below prepare third-party runtimes; they were checked against their
documentation, not executed as live model acceptance tests.

Start a runtime with a vision-capable model, then start Home Studio using
`python3 scripts/serve-ai-planner.py`. Open its printed address and choose **Plan
from photos**. Select the runtime, paste its exact model ID and numeric loopback
endpoint, and enter a local authentication token when configured. Plain `localhost`
and LAN addresses are intentionally rejected; use `127.0.0.1` or `[::1]` with an
explicit port. The profile supplies the inference path. See the [workflow](ai-planning.md),
[cloud providers](ai-provider-setup.md), and [architecture](ai-planner-architecture.md).

A runtime does not connect to the native HA editor or ordinary hosted editor automatically. Its offline
network policy remains unchanged. The companion serves UI and API on one local
origin, avoiding browser-to-runtime CORS and mixed-content workarounds. Furnish a
measured room or create a measured rectangle, then review before applying. Photos
cannot establish reliable dimensions by themselves.

## Choose the model and hardware together

For a desktop trial, Ollama offers a small CLI workflow; LM Studio offers graphical model discovery and loading. llama.cpp gives operators direct control over GGUF files and acceleration. vLLM suits people comfortable managing a compatible Python/GPU environment. LocalAI offers multiple backends behind an API. These are setup tradeoffs, not a quality ranking.

A text-only model can interpret written requirements but cannot inspect photos. Select a **vision-language model**, confirm its exact format and architecture are supported by the installed runtime, and read its license. A model family's name alone is insufficient: variants can differ in image support. For example, Ollama's Gemma 3 listing distinguishes text-only small variants from multimodal variants. The examples below are compatibility starting points, not measured Home Studio recommendations. [Ollama model listing](https://ollama.com/library/gemma3)

Size a trial as follows:

1. Record OS, CPU architecture, free disk space, available RAM, GPU/driver, and available VRAM. On unified-memory systems, applications and GPU allocations share the memory budget.
2. Inspect the selected weight files and quantization. An illustrative eight-billion-parameter model at four bits needs about four billion bytes for weights alone; metadata, vision encoder/projector, caches, and runtime allocations add more. File size is not a complete RAM requirement.
3. Start with one request, one reduced-resolution image, and a modest supported context. Reserve capacity for instructions, image tokens, the draft, and the operating system. Increasing context, image resolution/count, or concurrency increases resource demand.
4. Measure memory pressure and completion time with harmless fixtures on the actual machine. Reduce context/images, unload other models, or choose a smaller supported quantization if needed. Quantization may change quality; rerun the fixture.

Check each runtime's platform requirements before installing. LM Studio's requirements are a useful desktop reference, while vLLM has separate hardware installation paths. Neither a RAM figure nor GPU branding guarantees a particular model will fit or run quickly. [LM Studio requirements](https://lmstudio.ai/docs/app/system-requirements), [vLLM installation](https://docs.vllm.ai/en/latest/getting_started/installation/)

## Planner context and memory budget

The companion sends catalog vocabulary and the selected room in addition to your
instructions and images. A typical text envelope is tens of kilobytes, before
image tokens. Use a model and runtime context of at least **32,768 tokens**, with
capacity for the **8,192-token output allowance**; more photos or longer input may
need a larger window. The companion explicitly requests `num_ctx: 32768` from
Ollama. Configure the corresponding model-load context in LM Studio and LocalAI.
A tiny model test succeeding at an 8K context does not prove that a full planner
request will fit. If your hardware cannot support the context, use a compatible
smaller model or a cloud provider; do not silently truncate room evidence.

## Install and start a runtime

These are **third-party commands**, not Home Studio commands. They were checked against documentation, not executed as live model acceptance tests. They support harmless capability tests; complete the acceptance checklist before sending personal data. Record the installed version, model revision, quantization, and context setting. Check `--help` against that version: current documentation can describe features absent from an older package. Downloading applications, weights, tokenizers, projectors, or kernels can require Internet access and model-license acceptance.

Commands use a Unix shell. On Windows, use the runtime's documented installer and shell equivalents. For authenticated examples, set `HS_LOCAL_TOKEN` to a fresh random local-server token without placing its value in shell history; it is not a cloud provider key. Environment variables are convenient for a personal trial but remain accessible to sufficiently privileged local processes. Do not paste keys into screenshots or diagnostics.

### Ollama

Install from [Ollama's download page](https://ollama.com/download). Quit an already-running app/service before starting a second server. In the server terminal:

```sh
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NO_CLOUD=1 ollama serve
```

In another terminal, download a multimodal variant and check discovery:

```sh
ollama pull gemma3:4b
ollama list
curl --fail http://127.0.0.1:11434/api/tags
```

The native chat endpoint is `http://127.0.0.1:11434/api/chat`. For an app/service installation, apply the same environment settings using the OS-specific procedure and restart it. `OLLAMA_NO_CLOUD=1` disables Ollama's cloud features; also verify that the requested model is downloaded locally. Keep the server on loopback and do not broaden `OLLAMA_ORIGINS`. Local access still needs the companion protections described below. [Ollama configuration and cloud settings](https://docs.ollama.com/faq)

For a harmless local image, `ollama run gemma3:4b ./fixture.png 'Describe the visible shapes.'` checks the vision path. Native REST requests put base64 image bytes in a message's `images` array; structured requests put a JSON schema in top-level `format`. Test both together with the installed model. [Vision API](https://docs.ollama.com/capabilities/vision), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

### LM Studio

Install LM Studio, use Discover to download a supported vision model, and load it. The desktop runtime must support that model's GGUF or MLX architecture. In Developer server settings, leave network sharing off and enable **Require Authentication**; create a token with only the permissions needed. Authentication requires LM Studio 0.4.0 or newer. [Server setup](https://lmstudio.ai/docs/developer/core/server), [authentication](https://lmstudio.ai/docs/developer/core/authentication)

If the `lms` CLI is installed:

```sh
lms server start --bind 127.0.0.1 --port 1234
lms server status
```

Do not add `--cors`. Confirm the same settings in the graphical server controls if using those instead. The API base is `http://127.0.0.1:1234/v1`; query `/models` with the token to obtain the exact model identifier, then use `/chat/completions`. [CLI server options](https://lmstudio.ai/docs/cli/serve/server-start)

LM Studio accepts JSON-schema requests through `response_format`, but its documentation cautions that model capability varies. A completed text chat does not verify image input or schema quality. Model search, runtime downloads, and update checks need connectivity even though downloaded models can run offline. [Structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output), [offline operation](https://lmstudio.ai/docs/app/offline)

### llama.cpp

Use an official release or documented package; for Homebrew installations:

```sh
brew install llama.cpp
llama-server --version
```

Other supported package paths are listed in the [installation guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md). Download a supported vision GGUF and its matching multimodal projector. The following filenames are placeholders for files you have verified locally:

```sh
LLAMA_API_KEY="${HS_LOCAL_TOKEN:?Set a fresh local token first}" \
llama-server -m /path/to/vision-model.gguf \
  --mmproj /path/to/matching-projector.gguf \
  --host 127.0.0.1 --port 8081 --ctx-size 32768 \
  --cors-origins http://127.0.0.1:8081 --no-webui
```

The projector must match the model, not just its parameter count. This context value is a baseline for planner requests, not a guarantee that every image batch fits. The official multimodal guide lists compatible model/projector combinations. [Multimodal setup](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)

Check `http://127.0.0.1:8081/health`, then authenticated `/v1/models` and `/v1/chat/completions`. Health is public and can return 503 during loading. Current server documentation describes permissive CORS defaults, so the command explicitly narrows the origin; it also fixes the port instead of relying on a changing default. Do not enable agent tools, MCP proxies, or local media-directory access. Grammar/JSON-schema support uses a supported subset and its request wrapper must match the installed build. [Server reference](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

### vLLM

Follow the hardware-specific installation instructions. For a compatible Linux/NVIDIA setup with `uv` already installed, the documented route is:

```sh
uv venv .venv-vllm --python 3.12 --seed --managed-python
. .venv-vllm/bin/activate
uv pip install vllm --torch-backend=auto
vllm download-kernels
```

AMD, Intel, CPU, and Apple Silicon use different paths; do not apply the NVIDIA recipe indiscriminately. Apple Silicon support uses the separate vLLM-Metal package. [Hardware installation](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)

With a compatible vision model already downloaded, including its tokenizer/configuration:

```sh
VLLM_API_KEY="${HS_LOCAL_TOKEN:?Set a fresh local token first}" \
VLLM_NO_USAGE_STATS=1 \
vllm serve /path/to/local-vision-model --host 127.0.0.1 --port 8000 \
  --max-model-len 32768 --limit-mm-per-prompt '{"image":6}'
```

The base is `http://127.0.0.1:8000/v1`. Verify `/models`, then `/chat/completions`. A compatible chat template is required. Image limits, preprocessing, and supported architectures vary; adjust the trial context to the model and memory budget. [Multimodal inputs](https://docs.vllm.ai/en/latest/features/multimodal_inputs/)

Use the installed version's `response_format`/structured-output schema and validate the result. Usage statistics are enabled by default; the example opts out. **An API key does not protect every vLLM route:** current documentation lists `/invocations` among unauthenticated inference routes. Keep loopback isolation and allowlist companion/proxy routes; a token alone is insufficient. [Structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/), [usage statistics](https://docs.vllm.ai/en/latest/usage/usage_stats/), [security](https://docs.vllm.ai/en/latest/usage/security/)

### LocalAI

Download the matching native server release following the [Linux installation guide](https://localai.io/docs/installation/linux/index.html), or use the documented [macOS launcher](https://localai.io/docs/getting-started/macos/index.html). The launcher manages a separate server download. For explicit control, run the installed `local-ai` binary:

```sh
LOCALAI_API_KEY="${HS_LOCAL_TOKEN:?Set a fresh local token first}" \
LOCALAI_ADDRESS=127.0.0.1:8080 \
local-ai run "${HS_LOCAL_MODEL:?Set a compatible local vision model name first}"
```

Choose a LocalAI catalog vision model with the context capacity described above, set its name in HS_LOCAL_MODEL, and configure that context in its model settings. The command downloads needed assets. Confirm launcher/service settings use loopback before starting them instead; the CLI's default `:8080` is broader. Environment configuration takes precedence over flags. Keep CORS disabled and CSRF protection enabled. [CLI configuration](https://localai.io/docs/reference/cli-reference/), [vision model setup](https://localai.io/docs/features/gpt-vision/)

Use authenticated `http://127.0.0.1:8080/v1/models` and `/v1/chat/completions`. LocalAI's simple API keys confer administrative access, so the companion does not expose the full runtime API. Confirm the selected backend actually runs local weights and has no cloud proxy or remote failover. [Quickstart and authentication](https://localai.io/docs/basics/getting_started/index.html), [cloud proxy](https://localai.io/docs/features/cloud-proxy/)

Vision-plus-grammar support is backend-specific: the documented constrained-grammar path requires the llama.cpp backend. An OpenAI-compatible URL does not establish schema compatibility. [Constrained grammars](https://localai.io/docs/features/constrained_grammars/index.html)

## Verify capabilities before using room photos

For authenticated discovery/inference, use `Authorization: Bearer <local token>` without saving the token in an HTTP client's history. First request a tiny text response. Next send a locally made PNG containing recognizable shapes, using image bytes rather than a public URL. For OpenAI-style chat APIs, the message content includes a text item and an `image_url` item containing a base64 data URL; confirm support with the selected runtime. Ollama's native encoding differs as described above.

Finally request an object containing `objects` (an array of strings) and `uncertain` (a boolean), with both fields required and additional properties forbidden. Apply the runtime's documented schema wrapper. Parse the returned content and validate types and extra fields; repeat with image input included. Check that changing the fixture changes the observations. These checks establish a working path, not geometric accuracy or full planning-schema compliance.

For example, this text-only request checks Ollama's native schema path without reading a photograph:

```sh
curl --fail-with-body http://127.0.0.1:11434/api/chat \
  -H 'Content-Type: application/json' -d '{
    "model":"gemma3:4b",
    "messages":[{"role":"user","content":"List a square as the only object; uncertainty is false."}],
    "stream":false,
    "format":{
      "type":"object",
      "properties":{
        "objects":{"type":"array","items":{"type":"string"}},
        "uncertain":{"type":"boolean"}
      },
      "required":["objects","uncertain"],
      "additionalProperties":false
    }
  }'
```

Parse `message.content` as JSON; the outer HTTP response is a separate object. For other runtimes, use their documented wrapper and parse `choices[0].message.content`. Do not copy Ollama's `format` field into an OpenAI-compatible request. A successful response should contain an objects array describing a square and a false boolean; check structure and meaning separately. [Ollama response format](https://docs.ollama.com/capabilities/structured-outputs)

If a request fails, distinguish connection refusal/wrong port, 401/403 authentication, unknown model/404, unsupported image or schema/400, image/context limits, loading/overload, and out-of-memory errors. Consult the runtime's sanitized error details; status mappings vary. Reduce the request before changing hardware settings. Invalid JSON, truncation, or invented dimensions must block import. Do not silently remove constraints, switch to cloud inference, or overwrite the user's plan.

## Privacy and companion acceptance checklist

Local inference means execution on the selected machine only when the entire route is local. Downloads, update checks, telemetry, plugins, remote workers, and cloud fallback are separate network paths. Verify configuration and repeat a harmless request with outbound connectivity blocked after assets are installed. Success is useful evidence, not a blanket privacy guarantee: caches, swap, crash dumps, backups, browser extensions, and local administrators remain relevant.

The companion implements these boundaries; keep them in place when modifying or deploying it:

- Bind to numeric loopback; validate exact `Host` and browser `Origin` values, reject unexpected/null origins, require a fresh session credential, and protect state-changing requests against CSRF. Loopback binding and CORS alone do not prevent malicious websites or DNS rebinding.
- Serve UI/API from one origin; allow only the selected loopback runtime and necessary routes, reject redirects and arbitrary upstream URLs, and keep provider credentials server-side in memory. Isolate image decoding, strip metadata, and enforce file, pixel, image-count, context, and timeout limits.
- Never persist keys or photos in local/session storage, IndexedDB, service-worker caches, URLs, exports, or analytics. Disable payload/header logging and tracing throughout the companion/runtime path; check runtime disk caches separately. Cancellation stops and discards the pending request; selected photos remain available in browser memory for an explicit retry. Discard, Apply, panel close, or session end releases selected photos; session end or expiry clears credentials and remaining session state. Document limits of memory erasure.
- Treat image text and model output as untrusted data. Disable tools, shell execution, and network fetching. Validate the draft independently, display uncertainties, and require explicit review/import.

A public HTTPS page calling HTTP loopback may encounter CORS, mixed-content, or browser local/private-network restrictions. Behavior differs by browser/version; successful `curl` does not prove browser access. The separate same-origin companion avoids relying on that cross-origin route. Do not fix failures with wildcard CORS, public binds, or disabled browser protections. [Chrome's local-network security model](https://developer.chrome.com/blog/local-network-access/)
