/**
 * What each model costs, as published, in US dollars (docs/ai-models.md, docs/notes/models-spend.md). The gateway
 * reports tokens, not money, so Athena's spend is tokens times these prices.
 *
 * Token prices are per million tokens: [input, output, cached input, audio input]. They are the providers' list
 * prices as OpenRouter publishes them (openrouter.ai/api/v1/models), joined to the models the gateway lists
 * (api.netlify.com/api/v1/ai-gateway/providers), checked 17 Nov 2026. Anthropic's match its own price list.
 * Picture prices are per picture made, at the provider's standard size and quality.
 *
 * A model with no price here counts at the dearest known price from the same company and is marked "estimated
 * high" wherever spend shows (owner, 17 Nov 2026): better to stop early than to run past the budget.
 *
 * Pure: imported by the server and its tests. Keep it free of the database and the environment.
 */

/** [input, output, cached input, audio input] in $ per million tokens. Cached is null where the provider has none. */
export type TokenPrice = readonly [input: number, output: number, cached: number | null, audio?: number];

/** Every provider Athena pays for: the gateway's model providers, and TypeSafe's Jev. */
export type PricedProvider = "anthropic" | "openai" | "gemini" | "meta" | "openrouter" | "typesafe";

export const CHECKED = "2026-11-17";

export const TOKEN_PRICES: Record<PricedProvider, Record<string, TokenPrice>> = {
  anthropic: {
    "claude-fable-5": [10, 50, 1],
    "claude-fable-5-1": [10, 50, 0.25],
    "claude-fable-5-2": [8, 40, 0.2],
    "claude-haiku-4-5": [1, 5, 0.1],
    "claude-haiku-4-5-20251001": [1, 5, 0.1],
    "claude-haiku-5-5": [0.1, 0.5, 0.01],
    "claude-opus-4-5": [5, 25, 0.5],
    "claude-opus-4-5-20251101": [5, 25, 0.5],
    "claude-opus-4-6": [5, 25, 0.5],
    "claude-opus-4-7": [5, 25, 0.5],
    "claude-opus-4-8": [5, 25, 0.5],
    "claude-opus-5": [5, 25, 0.5],
    "claude-opus-5-5": [4, 20, 0.2],
    "claude-sonnet-4-5": [3, 15, 0.3],
    "claude-sonnet-4-5-20250929": [3, 15, 0.3],
    "claude-sonnet-4-6": [3, 15, 0.3],
    "claude-sonnet-5": [2, 10, 0.2],
    "claude-sonnet-5-5": [2, 10, 0.1],
  },
  gemini: {
    "gemini-2.5-flash-image": [0.3, 2.5, 0.03, 1],
    "gemini-3-flash-preview": [0.5, 3, 0.05, 1],
    "gemini-3-pro-image": [2, 12, 0.2, 2],
    "gemini-3.1-flash-image": [0.5, 3, null],
    "gemini-3.1-flash-lite": [0.25, 1.5, 0.025, 0.5],
    "gemini-3.1-flash-lite-image": [0.25, 1.5, null],
    "gemini-3.1-pro-preview": [2, 12, 0.2, 2],
    "gemini-3.1-pro-preview-customtools": [2, 12, 0.2, 2],
    "gemini-3.5-flash": [1.5, 9, 0.15, 3],
    "gemini-3.5-flash-lite": [0.3, 2.5, 0.03, 0.3],
    "gemini-3.6-flash": [0.75, 3.75, 0.075, 0.75],
    "gemini-3.7-flash": [0.75, 3.75, 0.075, 0.75],
    "gemini-3.8-flash": [0.825, 4.125, 0.0825, 0.825],
    "gemini-4-argon": [2, 10, 0.1, 2],
    "gemini-4-carbon": [2, 10, 0.1, 2],
    "gemini-4-hydrogen": [1.5, 7.5, 0.075, 1.5],
    "gemini-nano-banana-2.1": [1.5, 7.5, null],
  },
  meta: {
    "muse-ember-1.0": [0.1, 0.5, 0.004],
    "muse-spark-1.1": [1.25, 4.25, 0.15],
    "muse-spark-1.2": [1.25, 4.25, 0.15],
    "muse-spark-1.3": [1.25, 4.25, 0.15],
    "muse-wonder-1.0": [4, 20, 0.2],
  },
  openai: {
    "gpt-4.1": [2, 8, 0.5],
    "gpt-4.1-mini": [0.4, 1.6, 0.1],
    "gpt-4o": [2.5, 10, 1.25],
    "gpt-4o-mini": [0.15, 0.6, 0.075],
    "gpt-5": [1.25, 10, 0.125],
    "gpt-5-2025-08-07": [1.25, 10, 0.125],
    "gpt-5-mini": [0.25, 2, 0.025],
    "gpt-5-mini-2025-08-07": [0.25, 2, 0.025],
    "gpt-5-nano": [0.05, 0.4, 0.005],
    "gpt-5-pro": [15, 120, null],
    "gpt-5.1": [1.25, 10, 0.125],
    "gpt-5.1-2025-11-13": [1.25, 10, 0.125],
    "gpt-5.2": [1.75, 14, 0.175],
    "gpt-5.2-2025-12-11": [1.75, 14, 0.175],
    "gpt-5.2-pro": [21, 168, null],
    "gpt-5.2-pro-2025-12-11": [21, 168, null],
    "gpt-5.3-codex": [1.75, 14, 0.175],
    "gpt-5.4": [2.5, 15, 0.25],
    "gpt-5.4-2026-03-05": [2.5, 15, 0.25],
    "gpt-5.4-mini": [0.75, 4.5, 0.075],
    "gpt-5.4-mini-2026-03-17": [0.75, 4.5, 0.075],
    "gpt-5.4-nano": [0.2, 1.25, 0.02],
    "gpt-5.4-nano-2026-03-17": [0.2, 1.25, 0.02],
    "gpt-5.4-pro": [30, 180, null],
    "gpt-5.4-pro-2026-03-05": [30, 180, null],
    "gpt-5.5": [5, 30, 0.5],
    "gpt-5.5-2026-04-23": [5, 30, 0.5],
    "gpt-5.5-pro": [30, 180, null],
    "gpt-5.5-pro-2026-04-23": [30, 180, null],
    "gpt-5.6-luna": [0.2, 1.2, 0.02],
    "gpt-5.6-sol": [4, 20, 0.4],
    "gpt-5.6-terra": [2, 12, 0.2],
    "gpt-6-astra": [10, 50, 1],
    "gpt-6-luna": [0.1, 0.5, 0.01],
    "gpt-6-sol": [2, 10, 0.2],
    "gpt-6.1-sol": [2, 10, 0.1],
    "gpt-6.1-terra": [1, 5, 0.05],
    "o3": [2, 8, 0.5],
  },
  openrouter: {
    "anthracite-org/magnum-v4-72b": [2.5, 5, 2.5],
    "bytedance-seed/seed-2-1-turbo": [0.5, 2.5, null],
    "bytedance-seed/seed-2.0-lite": [0.25, 2, null],
    "bytedance-seed/seed-2.0-mini": [0.1, 0.4, null],
    "bytedance/ui-tars-1.5-7b": [0.1, 0.2, 0.1],
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": [0.2, 0.9, null],
    "cohere/command-a-plus": [0.3, 1.5, 0.15],
    "deepseek/deepseek-chat": [0.2574, 1.0287, null],
    "deepseek/deepseek-chat-v3.1": [0.25, 0.95, 0.13],
    "deepseek/deepseek-r1-0528": [0.5, 2.15, 0.35],
    "deepseek/deepseek-v3.2": [0.26, 0.38, 0.13],
    "deepseek/deepseek-v4-flash": [0.09, 0.18, 0.018],
    "deepseek/deepseek-v4-flash-0731": [0.06, 0.18, 0.015],
    "deepseek/deepseek-v4-flash-vision-exp": [0.44, 1.32, 0.014],
    "deepseek/deepseek-v4-pro": [0.9, 1.5, 0.25],
    "deepseek/deepseek-v4-pro-0813": [0.111, 4.44, 0.097],
    "deepseek/deepseek-v4.1-flash": [0.3, 1.2, 0.006],
    "deepseek/deepseek-v4.1-flash-1017": [0.036, 0.5, 0.01],
    "elorian/glimpse": [0.6, 3, 0.06],
    "fireworks/ember-1": [3, 15, 0.3],
    "google/gemma-2-27b-it": [0.65, 0.65, null],
    "google/gemma-3-12b-it": [0.05, 0.15, null],
    "google/gemma-3-27b-it": [0.08, 0.35, 0.04],
    "google/gemma-3-4b-it": [0.05, 0.1, null],
    "google/gemma-4-26b-a4b-it": [0.09, 0.3, 0.05],
    "google/gemma-4-31b-it": [0.2, 0.4, null],
    "gryphe/mythomax-l2-13b": [0.08, 0.11, null],
    "ibm-granite/granite-4.2-8b": [0.06, 0.15, 0.015],
    "inclusionai/ling-3.0-flash": [0.021, 0.063, 0.0042],
    "inclusionai/ling-3.0-flash-vl": [0.06, 0.18, 0.012],
    "inclusionai/ling-3.0-tiny": [0.015, 0.045, 0.003],
    "inclusionai/ling-3.1-flash": [0.045, 0.135, 0.009],
    "inclusionai/ling-3.2-flash:free": [0, 0, null],
    "inference-net/schematron-v2-small": [0.05, 0.23, 0.05],
    "inference-net/schematron-v2-turbo": [0.03, 0.15, 0.03],
    "liquid/lfm-2.5-24b-a2b": [0.05, 0.7, 0.025],
    "liquid/lfm-3-1.7b": [0.08, 0.2, 0.02],
    "mancer/weaver": [0.3, 0.5, 0.3],
    "meta-llama/llama-3.1-8b-instruct": [0.02, 0.04, null],
    "meta-llama/llama-3.2-1b-instruct": [0.027, 0.201, null],
    "meta-llama/llama-3.2-3b-instruct": [0.0509, 0.335, null],
    "meta-llama/llama-3.3-70b-instruct": [0.71, 0.71, 0.71],
    "meta-llama/llama-4-maverick": [0.35, 1, 0.17],
    "meta-llama/llama-4-scout": [0.1, 0.3, null],
    "meta-llama/llama-guard-4-12b": [0.18, 0.18, null],
    "meta/muse-glimmer-30b": [0.35, 1.5, 0.04],
    "meta/muse-spark-open": [1.25, 4.25, 0.15],
    "microsoft/phi-4": [0.07, 0.14, null],
    "minimax/minimax-m2.5": [0.295, 1.2, 0.06],
    "minimax/minimax-m2.7": [0.21, 0.84, 0.042],
    "minimax/minimax-m3": [0.3, 1.2, 0.06],
    "minimax/minimax-m3.1-flash": [0.075, 0.3, 0.0075],
    "mistralai/codestral-2508": [0.3, 0.9, 0.03],
    "mistralai/devstral-2512": [0.4, 2, 0.04],
    "mistralai/ministral-14b-2512": [0.2, 0.2, 0.02],
    "mistralai/ministral-3b-2512": [0.1, 0.1, 0.01],
    "mistralai/ministral-8b-2512": [0.15, 0.15, 0.015],
    "mistralai/mistral-large-2407": [2, 6, 0.2],
    "mistralai/mistral-large-2512": [0.5, 1.5, 0.05],
    "mistralai/mistral-large-4-0": [0.7, 2.1, 0.07],
    "mistralai/mistral-medium-3": [0.44, 2.2, 0.044],
    "mistralai/mistral-medium-3-5": [1.5, 7.5, null],
    "mistralai/mistral-medium-3.1": [0.44, 2.2, 0.044],
    "mistralai/mistral-nemo": [0.029, 0.03, null],
    "mistralai/mistral-saba": [0.2, 0.6, 0.02],
    "mistralai/mistral-small-24b-instruct-2501": [0.05, 0.08, null],
    "mistralai/mistral-small-2603": [0.15, 0.6, 0.015],
    "mistralai/mistral-small-3.1-24b-instruct": [0.351, 0.555, null],
    "mistralai/mistral-small-3.2-24b-instruct": [0.075, 0.2, null],
    "mistralai/mixtral-8x22b-instruct": [2, 6, 0.2],
    "mistralai/voxtral-small-24b-2507": [0.1, 0.3, 0.01, 100],
    "moondream/moondream3-preview": [0.3, 2.5, null],
    "moondream/moondream3.1-9b-a2b": [0.3, 2.5, null],
    "moonshotai/kimi-k2": [0.57, 2.3, null],
    "moonshotai/kimi-k2-0905": [0.6, 2.5, null],
    "moonshotai/kimi-k2-thinking": [0.6, 2.5, 0.15],
    "moonshotai/kimi-k2.5": [0.5, 2.5, 0.15],
    "moonshotai/kimi-k2.6": [0.65, 3.41, 0.15],
    "moonshotai/kimi-k2.7-code": [0.7, 3.75, 0.17],
    "moonshotai/kimi-k3": [0.192, 16, 0.182],
    "moonshotai/kimi-k3.1-pro": [0.2403, 8.4023, 0.2],
    "morph/morph-v3-fast": [0.8, 1.2, null],
    "morph/morph-v3-large": [0.9, 1.9, null],
    "nousresearch/hermes-4-405b": [1, 3, 0.2],
    "nvidia/nemotron-3-nano-30b-a3b": [0.06, 0.24, 0.012],
    "nvidia/nemotron-3-super-120b-a12b": [0.075, 0.4, null],
    "nvidia/nemotron-3-ultra-550b-a55b": [0.5, 2.2, 0.1],
    "nvidia/nemotron-3.5-content-safety": [0.2, 0.2, null],
    "nvidia/nemotron-3.5-lightning": [0.07, 0.2, 0.04],
    "nvidia/nemotron-3.5-super-vl": [0.15, 0.5, 0.02],
    "nvidia/switchyard": [-1000000, -1000000, null],
    "openai/gpt-oss-120b": [0.15, 0.6, 0.075],
    "openai/gpt-oss-20b": [0.018, 0.09, 0.009],
    "openai/gpt-oss-safeguard-20b": [0.075, 0.3, 0.0375],
    "openrouter/auto": [-1000000, -1000000, null],
    "openrouter/auto-beta": [-1000000, -1000000, null],
    "openrouter/auto-code": [-1000000, -1000000, null],
    "openrouter/free": [0, 0, null],
    "openrouter/pareto-code": [-1000000, -1000000, null],
    "particle-ai/particle-1": [0.06, 0.5, 0.003],
    "perceptron/perceptron-mk1": [0.15, 1.5, null],
    "perceptron/perceptron-mk1.5": [0.15, 1.5, null],
    "perplexity/sonar": [1, 1, null],
    "perplexity/sonar-deep-research": [2, 8, null],
    "perplexity/sonar-pro": [3, 15, null],
    "perplexity/sonar-pro-search": [3, 15, null],
    "perplexity/sonar-reasoning-pro": [2, 8, null],
    "qwen/qwen-2.5-72b-instruct": [0.36, 0.4, null],
    "qwen/qwen-2.5-coder-32b-instruct": [0.66, 1, null],
    "qwen/qwen2.5-vl-72b-instruct": [0.8, 1, 0.4],
    "qwen/qwen3-14b": [0.12, 0.24, null],
    "qwen/qwen3-235b-a22b-2507": [0.14, 0.8, 0.05],
    "qwen/qwen3-235b-a22b-thinking-2507": [0.45, 3.5, null],
    "qwen/qwen3-30b-a3b": [0.12, 0.5, null],
    "qwen/qwen3-30b-a3b-instruct-2507": [0.1, 0.3, 0.1],
    "qwen/qwen3-32b": [0.08, 0.28, null],
    "qwen/qwen3-coder": [0.3, 1, 0.1],
    "qwen/qwen3-coder-next": [0.12, 0.8, 0.07],
    "qwen/qwen3-next-80b-a3b-instruct": [0.09, 1.1, null],
    "qwen/qwen3-vl-235b-a22b-instruct": [0.21, 1.9, 0.1],
    "qwen/qwen3-vl-30b-a3b-instruct": [0.15, 0.6, null],
    "qwen/qwen3-vl-8b-instruct": [0.25, 0.75, 0.12],
    "qwen/qwen3.5-122b-a10b": [0.26, 2.08, null],
    "qwen/qwen3.5-27b": [0.26, 2.6, null],
    "qwen/qwen3.5-35b-a3b": [0.14, 1, 0.05],
    "qwen/qwen3.5-397b-a17b": [0.45, 3, 0.22],
    "qwen/qwen3.5-9b": [0.17, 0.25, 0.153],
    "qwen/qwen3.6-27b": [0.32, 3.2, null],
    "qwen/qwen3.6-35b-a3b": [0.1, 0.9, 0.025],
    "qwen/qwen3.8-2.4t-a95b": [2, 6, 0.25],
    "qwen/qwen3.8-27b": [0.15, 1.875, 0.0375],
    "reflection/beam-1.0-501b-a23b": [0.3, 1, 0.04],
    "rekaai/reka-edge": [0.1, 0.1, null],
    "rekaai/reka-flash-3": [0.1, 0.2, null],
    "relace/relace-apply-3": [0.85, 1.25, null],
    "relace/relace-search": [1, 3, null],
    "ricursiveai/ripple-65b-preview": [0.1, 0.3, 0.025],
    "sao10k/l3-lunaris-8b": [0.04, 0.05, null],
    "sao10k/l3.1-euryale-70b": [0.85, 0.85, null],
    "scaledown/extract": [0.04, 0, null],
    "scaledown/summarize": [0.04, 0, null],
    "stepfun/step-3.7-flash": [0.2, 1.15, 0.04],
    "stepfun/step-5-preview": [1, 2.7, 0.1],
    "tencent/hy-mt2-1.8b": [0.044, 0.177, null],
    "tencent/hy-mt2-30b-a3b": [0.074, 0.295, null],
    "tencent/hy-mt2-7b": [0.074, 0.295, null],
    "tencent/hy3": [0.0825, 0.33, 0.0206],
    "tencent/hy4": [0.417, 1.2505, 0.021],
    "tencent/hy4-flash": [0.035, 0.1405, 0.0015],
    "tencent/hy4-preview": [0.7506, 2.2509, 0.0378],
    "thedrummer/cydonia-24b-v4.1": [0.3, 0.5, 0.15],
    "thedrummer/skyfall-36b-v2": [0.55, 0.8, 0.25],
    "thedrummer/unslopnemo-12b": [0.4, 0.4, null],
    "thinkingmachines/inkling": [1, 4.05, 0.17],
    "thinkingmachines/inkling-2-small": [0.3, 1, 0.03],
    "thinkingmachines/inkling-small": [0.45, 1.2, 0.1],
    "typesafe/jev-router": [-1000000, -1000000, null],
    "unbiased/pareto-26.10": [0.8, 3.2, 0.03],
    "undi95/remm-slerp-l2-13b": [0.3, 0.5, 0.2],
    "upstage/solar-mini4": [0.05, 0.2, 0.005],
    "upstage/solar-pro4": [0.15, 0.6, 0.03],
    "x-ai/grok-4.20": [1.25, 2.5, 0.2],
    "x-ai/grok-4.20-multi-agent": [1.25, 2.5, 0.2],
    "x-ai/grok-4.3": [1.25, 2.5, 0.2],
    "x-ai/grok-4.5": [2, 6, 0.3],
    "x-ai/grok-4.6": [2, 6, 0.5],
    "x-ai/grok-4.7": [2, 6, 0.5],
    "x-ai/grok-build-0.1": [1, 2, 0.2],
    "xiaomi/mimo-v2.5": [0.4, 2, 0.08],
    "xiaomi/mimo-v2.5-pro": [0.435, 0.87, 0.0036],
    "xiaomi/mimo-v2.6-flash": [0.14, 0.28, 0.0028],
    "xiaomi/mimo-v2.6-pro": [0.435, 0.87, 0.0036],
    "z-ai/glm-4.5-air": [0.13, 0.85, 0.025],
    "z-ai/glm-4.5v": [0.6, 1.8, 0.11],
    "z-ai/glm-4.6": [0.5, 2, 0.1],
    "z-ai/glm-4.6v": [0.3, 0.9, 0.055],
    "z-ai/glm-4.7": [0.4, 1.75, 0.08],
    "z-ai/glm-4.7-flash": [0.0605, 0.4, null],
    "z-ai/glm-5": [1, 3.2, 0.2],
    "z-ai/glm-5.1": [1.4, 4.4, 0.26],
    "z-ai/glm-5.2": [0.007, 6.8, 0.006],
    "z-ai/glm-5.3": [0.0699, 1.4, 0.0689],
    "z-ai/glm-5.3-flash": [0.15, 0.5, 0.03],
    "~deepseek/deepseek-flash-latest": [0.036, 0.5, 0.01],
    "~deepseek/deepseek-pro-latest": [0.0999, 8, 0.0999],
    "~deepseek/deepseek-v4-flash-latest": [0.0434, 0.3, 0.035],
    "~moonshotai/kimi-latest": [0.1824, 11.0055, 0.18],
    "~unbiased/pareto-latest": [0.8, 3.2, 0.03],
    "~x-ai/grok-latest": [2, 6, 0.5],
    "~z-ai/glm-flash-latest": [0.0399, 0.0784, 0.03],
    "~z-ai/glm-latest": [0.0699, 1.4, 0.0689],
  },  // Jev: $0.04 per million input tokens and nothing for output (lib/jev.ts).
  typesafe: {
    jev: [0.04, 0, null],
  },
};

/**
 * $ per picture made, at the standard size (1024 px) and quality. Google charges Gemini's pictures as output
 * tokens (about 1,290 a picture); these are its published per-picture equivalents. OpenAI's gpt-image models
 * are charged per picture by size and quality; the medium-quality square price is used.
 */
export const PICTURE_PRICES: Partial<Record<PricedProvider, Record<string, number>>> = {
  gemini: {
    "gemini-2.5-flash-image": 0.039,
    "gemini-3.1-flash-image": 0.067,
    "gemini-3.1-flash-lite-image": 0.039,
    "gemini-3-pro-image": 0.134,
  },
  openai: {
    "gpt-image-1.5": 0.034,
  },
};

/** A model's price, and whether it was known or put at the dearest from the same company. */
export interface Priced<T> {
  price: T;
  estimated: boolean;
}

/** A dated id ("gpt-5-2025-08-07", "claude-haiku-4-5-20251001") priced as the model it dates. */
const undated = (model: string): string => model.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");

/** The most a known model of this company costs, per part: the "estimated high" stand-in. */
function dearestTokens(provider: PricedProvider): TokenPrice {
  const all = Object.values(TOKEN_PRICES[provider] ?? {});
  if (!all.length) return dearestTokens("anthropic");
  const max = (i: 0 | 1) => Math.max(...all.map((p) => p[i]));
  const cached = all.map((p) => p[2]).filter((c): c is number => c !== null);
  const audio = all.map((p) => p[3] ?? 0);
  return [max(0), max(1), cached.length ? Math.max(...cached) : null, Math.max(...audio) || undefined];
}

export function tokenPrice(provider: PricedProvider, model: string): Priced<TokenPrice> {
  const table = TOKEN_PRICES[provider] ?? {};
  const known = table[model] ?? table[undated(model)];
  return known ? { price: known, estimated: false } : { price: dearestTokens(provider), estimated: true };
}

export function picturePrice(provider: PricedProvider, model: string): Priced<number> {
  const table = PICTURE_PRICES[provider] ?? {};
  const known = table[model] ?? table[undated(model)];
  if (known !== undefined) return { price: known, estimated: false };
  const all = Object.values(table);
  const any = Object.values(PICTURE_PRICES).flatMap((t) => Object.values(t ?? {}));
  return { price: Math.max(...(all.length ? all : any)), estimated: true };
}

/**
 * Which provider a model id belongs to, for a call that only knows the id (lib/ai.ts sees `params.model`). The
 * gateway's ids don't overlap: OpenRouter's carry a slash, the others their company's own prefix.
 */
export function providerOf(model: string): PricedProvider {
  if (model.includes("/")) return "openrouter";
  if (/^claude-/.test(model)) return "anthropic";
  if (/^gemini-/.test(model)) return "gemini";
  if (/^(gpt-|o\d|chat-latest|codex)/.test(model)) return "openai";
  if (/^(muse-|llama)/.test(model)) return "meta";
  return "anthropic";
}

/** Tokens as a reply reports them (Anthropic's shape, which lib/llm keeps for every provider). */
export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Audio sent in (lib/voice.ts), priced at the model's audio rate where it has one. */
  audio_input_tokens?: number | null;
}

/** Writing to Anthropic's cache costs a quarter more than plain input (5-minute cache). */
const CACHE_WRITE = 1.25;

/** What one call cost, in dollars. */
export function tokenCost(provider: PricedProvider, model: string, usage: TokenUsage): Priced<number> {
  const { price, estimated } = tokenPrice(provider, model);
  const [input, output, cached, audio] = price;
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const usd =
    (n(usage.input_tokens) * input +
      n(usage.output_tokens) * output +
      n(usage.cache_read_input_tokens) * (cached ?? input) +
      n(usage.cache_creation_input_tokens) * input * (provider === "anthropic" ? CACHE_WRITE : 1) +
      n(usage.audio_input_tokens) * (audio ?? input)) /
    1_000_000;
  return { price: usd, estimated };
}
