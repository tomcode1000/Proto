/**
 * Model provider selection.
 *
 * Proto is provider-agnostic on purpose: the agent logic never names a vendor.
 * Development runs on a free tier; swapping to Amazon Bedrock is a single
 * environment variable, no code change.
 *
 * Tool calling is the core of this agent, so provider choice matters more than
 * usual — a model with weak function-calling support will fail in ways that look
 * like application bugs.
 */
import { BedrockModel } from '@strands-agents/sdk'

/** OpenAI-compatible endpoints, reached through the OpenAI provider. */
const COMPATIBLE = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    signupUrl: 'https://openrouter.ai/keys',
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    signupUrl: 'https://console.groq.com/keys',
  },
}

const NATIVE_DEFAULTS = {
  google: 'gemini-2.5-flash',
  bedrock: 'global.anthropic.claude-sonnet-4-6',
  openai: 'gpt-5.4',
}

function required(envKey, signupUrl) {
  const value = process.env[envKey]
  if (!value) {
    throw new Error(`${envKey} is not set. Get a key at ${signupUrl} and add it to .env`)
  }
  return value
}

export async function buildModel() {
  const provider = (process.env.PROTO_MODEL_PROVIDER ?? 'google').toLowerCase()

  if (provider in COMPATIBLE) {
    const { baseURL, envKey, defaultModel, signupUrl } = COMPATIBLE[provider]
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
    return new OpenAIModel({
      api: 'chat',
      modelId: process.env.PROTO_MODEL_ID ?? defaultModel,
      apiKey: required(envKey, signupUrl),
      // Free tiers cap affordable tokens well below the SDK default (65535).
      maxTokens: Number(process.env.PROTO_MAX_TOKENS ?? 2048),
      clientConfig: { baseURL },
    })
  }

  const modelId = process.env.PROTO_MODEL_ID ?? NATIVE_DEFAULTS[provider]

  if (provider === 'google') {
    const apiKey = required('GOOGLE_API_KEY', 'https://aistudio.google.com/apikey')
    const { GoogleModel } = await import('@strands-agents/sdk/models/google')
    return new GoogleModel({ apiKey, modelId })
  }

  if (provider === 'bedrock') {
    return new BedrockModel({
      region: process.env.AWS_REGION ?? 'us-east-1',
      modelId,
      maxTokens: 4096,
    })
  }

  if (provider === 'openai') {
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
    return new OpenAIModel({ api: 'chat', modelId })
  }

  throw new Error(
    `Unknown PROTO_MODEL_PROVIDER "${provider}". ` +
      `Use one of: google, openrouter, groq, bedrock, openai.`,
  )
}
