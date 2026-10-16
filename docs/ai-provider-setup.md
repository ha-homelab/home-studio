# AI provider setup

**Implemented adapters; live model compatibility requires a user smoke test.**
Official documentation checked **2026-10-16**. Automated tests use synthetic payloads
and mock servers, not provider accounts, private photos or paid requests. Console
labels, model access, prices, and API capabilities can change.

Start the [local companion](ai-planning.md), choose a profile, enter your exact model
ID and key, then connect. Select a vision model for photographs. Connect stores
settings locally; Generate is the action that actually calls the model. The
[architecture](ai-planner-architecture.md) describes the implemented boundaries;
[local models](ai-local-models.md) covers same-computer inference.

Implemented cloud profiles are OpenAI and xAI Responses; native Anthropic Messages;
Google Gemini's OpenAI-compatible endpoint; Mistral, OpenRouter, Groq, Together,
Fireworks Chat Completions; and DeepSeek text-only JSON mode. A listed provider is
not a promise that every model on it supports this request. DeepSeek's profile
rejects images. There is no automatic model selection or paid fallback.

Typical requests need at least a **32,768-token context window** with room for an
**8,192-token output allowance**. Catalog vocabulary, your instructions and image
tokens also consume context; longer requests may need more. Choose a model that
supports this output allowance. Requests are bounded but the UI does not estimate
provider-specific token counts or cost. No request is retried automatically.

## Before creating a key

An API account authorizes software to make requests. A consumer chat subscription is
not an API key: do not assume a ChatGPT, Claude, Gemini, or Grok subscription supplies
developer API credit. Check the selected provider's API billing account and terms;
trial allowances and bundled credits are provider-specific. The provider billing
guides linked below govern usage, not Home Studio. For example, OpenAI documents
[API pricing separately from subscription usage](https://learn.chatgpt.com/docs/pricing).

The intended result is editable room geometry, not a generated picture of a floor
plan. Select a model that accepts **image input and produces structured text**, then
verify both capabilities together. Image generation alone is insufficient. Even valid
JSON can contain incorrect dimensions: provide measured reference lengths, identify
unknown measurements, and review the proposed walls and openings before applying them.

For each provider, prepare a dedicated project or workspace where available, a named
key with minimum required permissions, and a small usage budget. Keep the key out of
project files, screenshots, prompts, issue reports, and browser storage. Store a backup
in your own password manager if needed. Do not paste keys into this documentation.

The default transport is an optional local companion serving Home Studio and
its API bridge from the same origin. The key is held in session memory, cleared
on disconnect or expiry, and sent over HTTPS to the selected provider for authentication.
Selected photos, instructions, and required plan context go to that provider.
With a gateway, that gateway receives the request and routes its content to an upstream
provider. Memory-only handling does not mean nothing is transmitted or retained by
the provider. Review the overview's privacy requirements before using room photos.

Direct browser requests are not implemented. A future direct mode would require a dedicated trusted origin: the endpoint must support
the browser's CORS requests, and page scripts or extensions can access exposed secrets.
The [OpenAI JavaScript SDK](https://developers.openai.com/api/reference/typescript)
disables browser use by default and requires an explicit `dangerouslyAllowBrowser`
override. That override does not grant CORS permission or make a browser key private.

## OpenAI

1. Sign in to the [API platform](https://platform.openai.com/), select the intended
   organization, and create or select a dedicated project.
2. Configure API billing and review usage limits in platform settings. Set spend
   alerts and, where appropriate, a hard limit; an alert alone does not stop requests.
3. Create a project API key, name it for this use, restrict permissions where supported,
   configure expiry if offered, and copy it into your own secure storage. Revoke
   a trial key when it is no longer needed. See the
   [quickstart](https://developers.openai.com/api/docs/quickstart) and
   [account and key guidance](https://developers.openai.com/api/docs/guides/production-best-practices).
4. Choose an accessible model from the [model catalog](https://developers.openai.com/api/docs/models).
   Confirm image input, structured outputs, context size, output limit, and current price.

The adapter targets `https://api.openai.com/v1/responses` with Bearer
authentication. Responses uses `input_image` content and `text.format` for schema
output; Chat Completions uses different message and `response_format` fields. Do not
mix their request shapes. Images can be supplied by URL, base64 data URL, or supported
file reference. For private room photos, the adapter uses inline bytes over creating
public URLs or persistent file uploads. See
[vision](https://developers.openai.com/api/docs/guides/images-vision) and
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Handle refusals, incomplete output, and unsupported schema keywords explicitly.
Structured outputs constrain the response format; Home Studio must still validate
geometry and permissions before making changes.

## Anthropic / Claude API

1. Sign in to the [Claude Console](https://platform.claude.com/) and select the
   organization/workspace intended for planning.
2. Open Console **Billing** to manage the payment method and buy API credits; review
   organization/workspace spend limits. See
   [billing and payment](https://platform.claude.com/docs/en/about-claude/pricing) and the
   [API overview](https://platform.claude.com/docs/en/api/overview). Eligible Max/Team
   subscribers can instead first [claim included API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
   by linking a Console organization; check eligibility and expiry.
3. Open **API keys**, create a named personal key for your own use, choose expiry and
   workspace scope, and copy the one-time value. Follow
   [Get your Claude API key](https://platform.claude.com/docs/en/get-api-key).
4. Check the [models overview](https://platform.claude.com/docs/en/models/overview)
   and capability guides for the exact model you can access.

Claude's native endpoint is `https://api.anthropic.com/v1/messages`. Its API requires
`anthropic-version` and authentication; the documented `x-api-key` form remains
supported. Use a workspace-scoped key. Keys requiring an additional `anthropic-workspace-id` header are not supported by this initial connection form.
Use the native adapter rather than assuming OpenAI field names work.

[Vision](https://platform.claude.com/docs/en/build-with-claude/vision) uses `image`
content blocks with base64, URL, or supported file sources. Limits depend on image
count, model, and hosting platform. Current
[structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
use `output_config.format`; older beta examples may use deprecated fields. The adapter removes bounds keywords unsupported by Claude from its grammar, keeps the complete schema in the prompt, and enforces all numeric, length and collection bounds in the local draft validator. Check
schema restrictions and stop reasons, and do not combine incompatible features such
as citations with a strict JSON response.

## Google Gemini Developer API

The implemented profile uses `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, Bearer authentication and OpenAI-compatible image/schema fields. The native Interactions API discussed below is background reference, not the active adapter. Choose a model supported on the compatibility endpoint.

1. Open [Google AI Studio](https://aistudio.google.com/). New users may receive a
   default Cloud project and key; existing users can import a Cloud project through
   **Dashboard → Projects**.
2. In **API Keys**, create a key in that project. Key creation needs project
   permissions. The [key guide](https://ai.google.dev/gemini-api/docs/api-key) describes
   the transition to service-account-bound authorization keys and restrictions on
   older standard keys; do not remove restrictions to work around an error.
3. For paid access, select **Set up billing** for that project, link or create the
   billing account, and complete the prepayment or billing flow shown. Verify the
   project's status and available credit in the
   [billing guide](https://ai.google.dev/gemini-api/docs/billing).
4. Choose a model using the [catalog](https://ai.google.dev/gemini-api/docs/models),
   checking availability, modalities, schema support, and free/paid-tier differences.

Current native image and schema examples use
`https://generativelanguage.googleapis.com/v1beta/interactions` with `x-goog-api-key`.
The [image guide](https://ai.google.dev/gemini-api/docs/image-understanding) shows inline
base64 or uploaded-file references. Its current inline request limit is 20 MB including
the other request content. The
[schema guide](https://ai.google.dev/gemini-api/docs/structured-output) uses JSON MIME
type and a schema in the response format, with a supported subset of JSON Schema.

Google also documents an [OpenAI-compatible API](https://ai.google.dev/gemini-api/docs/openai)
at `https://generativelanguage.googleapis.com/v1beta/openai/`. It uses Chat Completions
shapes and Bearer authentication. This is a separate adapter choice; do not copy
Interactions fields into it or assume identical feature coverage. Vertex AI is also
a separate configuration, described below.

## xAI / Grok API

1. Sign in to [console.x.ai](https://console.x.ai/), select the intended account/team,
   and add API credits.
2. Create a key on **API Keys**, give it a recognizable name, and retain the secret
   securely. These steps are in the [quickstart](https://docs.x.ai/developers/quickstart).
3. Select an accessible model from [Models & Pricing](https://docs.x.ai/developers/models)
   and verify image understanding and structured text output for that model.

The current quickstart uses `https://api.x.ai/v1/responses`, Bearer authentication,
and Responses-compatible inputs; Chat Completions is documented as a legacy route.
[Image understanding](https://docs.x.ai/developers/model-capabilities/images/understanding)
accepts `input_image` with a public URL or base64 data URL. The separate Imagine image
generation API is not an editable-plan API.
[Structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)
support a JSON Schema subset. Check model restrictions and use the fields documented
for the chosen endpoint, including `text.format` on Responses.

## Mistral

1. Sign in to [Mistral Studio](https://console.mistral.ai/). An organization and default
   workspace are created on signup; select the intended workspace.
2. Review [billing](https://docs.mistral.ai/admin/billing-usage/billing). For usage beyond
   included allowances, configure a payment method, enable pay-as-you-go, and maintain
   credit. Set organization/workspace limits.
3. Create a key in Studio or **Admin → API → API Keys**, select workspace and expiry,
   and copy its one-time value. See [API keys](https://docs.mistral.ai/admin/identity-access/api-keys)
   and the [quickstart](https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request).

Use `https://api.mistral.ai/v1/chat/completions` with Bearer authentication, as shown
in the [API reference](https://docs.mistral.ai/api). Check the
[model metadata](https://docs.mistral.ai/api/endpoint/models) for vision capability;
the Mistral name alone does not establish it. The
[vision extraction example](https://docs.mistral.ai/resources/cookbooks/mistral-image_understanding-image_description_prompting_pixtral)
combines an image with structured text output. Use
[custom structured outputs](https://docs.mistral.ai/studio/conversations/structured-output/custom)
for a defined schema, not merely JSON mode. Preserve the documented Mistral image-block
shape and validate the returned object locally.

## OpenRouter gateway

1. Create an [OpenRouter account](https://openrouter.ai/), add credits for paid models,
   and create a dedicated API key with a small spending limit. See
   [getting started and billing](https://openrouter.ai/support/) and the
   [quickstart](https://openrouter.ai/docs/cookbook/get-started/quickstart).
2. Select a full `author/model` identifier from the catalog. Check that
   `architecture.input_modalities` contains `image`, and that the selected provider
   endpoint supports the requested schema parameters.
3. Configure routing deliberately. For strict schema requests, use
   `provider.require_parameters: true`, as described in
   [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

The Chat Completions endpoint is `https://openrouter.ai/api/v1/chat/completions`,
authenticated with the OpenRouter key. Its
[image guide](https://openrouter.ai/blog/tutorials/send-image-to-llm/) explains URL and
base64 inputs and provider-specific limits. OpenRouter receives request content, and
an upstream provider processes it. Review both parties' policies and routing settings.
Connecting your own upstream key to a gateway is an additional credential-sharing
decision, not the same as calling that provider directly.

## Other OpenAI-compatible services

Compatibility covers particular endpoints and fields, not every OpenAI capability.
For each service: create an account, verify billing, create a dedicated key, choose
an exact available model, then test text, image input, and schema output separately
and together. Never silently discard photos when the selected model lacks vision.

- **Groq:** create the key in Groq Console; manage paid access and limits under
  **Settings → Billing**. Its [compatibility guide](https://console.groq.com/docs/openai)
  gives `https://api.groq.com/openai/v1` as the base URL. Check
  [vision models and limits](https://console.groq.com/docs/vision), plus
  [billing](https://console.groq.com/docs/billing-faqs).
- **Together:** create a project key and add credit through billing settings. Use
  `https://api.together.ai/v1/chat/completions`. The
  [quickstart](https://docs.together.ai/docs/quickstart) includes image and schema
  examples; [credit requirements](https://docs.together.ai/docs/billing-credits) apply
  to access. Confirm your exact model supports both examples' capabilities.
- **Fireworks:** create a key in its dashboard, add a payment method, and purchase
  prepaid credits as described in [pricing](https://fireworks.ai/pricing).
  Use `https://api.fireworks.ai/inference/v1/chat/completions` and the full model
  identifier, typically `accounts/.../models/...`. The
  [serverless quickstart](https://docs.fireworks.ai/getting-started/quickstart) documents
  image and structured-output examples; model/deployment availability still matters.
- **DeepSeek:** create a platform key and add balance as required. Its
  [quickstart](https://api-docs.deepseek.com/) uses
  `https://api.deepseek.com/chat/completions`. The
  [model capability table](https://api-docs.deepseek.com/quick_start/pricing) distinguishes
  vision-capable and text-only models. Its documented
  [JSON mode](https://api-docs.deepseek.com/guides/json_mode) uses `json_object`, requires
  a JSON instruction, and can return empty output. Do not treat that as a strict
  schema guarantee.

## Enterprise cloud routes

These require separate future adapters and deployment-specific capability checks:

- **Azure OpenAI:** provision an Azure resource and model deployment. Configure its
  resource endpoint, deployment name, and key or Microsoft Entra identity. The
  `model` argument identifies your deployment. See
  [Azure endpoint differences](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/switching-endpoints).
- **Amazon Bedrock:** configure AWS account access, model access, region, and IAM
  credentials or the supported Bedrock API-key flow. AWS SDKs can sign requests;
  this is not an arbitrary OpenAI base-URL substitution. See
  [Bedrock API setup](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started-api.html).
- **Google Vertex AI:** configure a Cloud project, billing, enabled API, location,
  and IAM/authentication. Google's current
  [Cloud quickstart](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start)
  documents these separately from AI Studio, including Application Default Credentials.
  Do not assume a Gemini Developer API key grants access to this route.

## Verification and troubleshooting

Before using a selected model with private photos, use a synthetic room image and a small schema to
verify the complete path. A successful model-list request establishes neither vision
nor schema compatibility. Check actual usage cost, cancellation, refusal handling,
and session cleanup. Record provider, endpoint, model ID, adapter version, and date;
never record keys or raw private request bodies.

- **401/403:** check the selected provider, key expiry, project/workspace permissions,
  required headers, and regional/model access. Avoid repeatedly generating new keys
  before identifying the cause.
- **402, insufficient credit, or quota error:** inspect the API billing account and
  project, available balance, and spend limit. A paid chat subscription is not a fix.
- **404/model unavailable:** copy the exact current model or deployment identifier;
  check the endpoint family and account access.
- **400/413/image rejected:** check MIME type, base64 encoding, dimensions, image count,
  total request size, and whether the model accepts images. Reduce attachments rather
  than silently dropping them. A cloud API cannot fetch your local file path or
  browser-only `blob:` URL; the adapter must send supported image bytes or references.
- **Schema rejected, empty, or incomplete output:** check supported schema keywords,
  output-token limits, refusals, and completion status. Validate before showing an
  apply action; do not execute returned code.
- **429/5xx/timeout:** respect retry guidance and use bounded backoff. Repeated
  generations can cost money; an interrupted client does not prove billing stopped.
- **Browser fetch/CORS failure:** use the local companion; the hosted editor intentionally has no AI network access.
  Do not disable browser security or send a key through an untrusted public proxy.

These are diagnostic categories, not a promise that every provider uses identical
HTTP status codes. Preserve a redacted request ID and consult that provider's error
documentation when reporting a failure.
