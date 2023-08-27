import './fetch-polyfill'

import {info, setFailed, warning} from '@actions/core'
import {
  ChatGPTAPI,
  ChatGPTError,
  ChatMessage,
  SendMessageOptions
  // eslint-disable-next-line import/no-unresolved
} from 'chatgpt'
import pRetry from 'p-retry'
import {OpenAIOptions, Options} from './options'

// define type to save parentMessageId and conversationId
export interface Ids {
  parentMessageId?: string
  conversationId?: string
}

function customFetch(
  input: RequestInfo | URL,
  opts: RequestInit | undefined
): Promise<Response> {
  warning('Using custom fetch')

  // Log the URL being accessed
  const newUrl = `${input}?api-version=2023-03-15-preview`

  // Add the API key
  // @ts-ignore
  opts.headers['api-key'] = process.env.AZURE_API_KEY
  // remove the header 'Authorization' to avoid error
  // @ts-ignore
  delete opts.headers['Authorization']
  // @ts-ignore
  delete opts.headers['OpenAI-Organization']

  // Log the headers (excluding sensitive data)
  // @ts-ignore
  const headersForLog = {...opts.headers}
  // @ts-ignore
  warning(`Request URL: ${newUrl}`)
  warning(`Headers: ${JSON.stringify(headersForLog)}`)

  return fetch(newUrl, opts)
}

export class Bot {
  private readonly api: ChatGPTAPI | null = null // not free
  private readonly options: Options

  constructor(options: Options, openaiOptions: OpenAIOptions) {
    this.options = options

    // Check if AZURE_API_KEY is available
    if (process.env.AZURE_API_KEY) {
      const currentDate = new Date().toISOString().split('T')[0]
      const systemMessage = `${options.systemMessage} 
Knowledge cutoff: ${openaiOptions.tokenLimits.knowledgeCutOff}
Current date: ${currentDate}

IMPORTANT: Entire response must be in the language with ISO code: ${options.language}
`

      this.api = new ChatGPTAPI({
        apiBaseUrl: options.apiBaseUrl,
        systemMessage,
        apiKey: process.env.AZURE_API_KEY,
        debug: options.debug,
        maxModelTokens: openaiOptions.tokenLimits.maxTokens,
        maxResponseTokens: openaiOptions.tokenLimits.responseTokens,
        completionParams: {
          temperature: options.openaiModelTemperature,
          model: openaiOptions.model
        },
        fetch: customFetch
      })
    } else {
      const err =
        "Unable to initialize the OpenAI API, 'AZURE_API_KEY' environment variable is not available"
      throw new Error(err)
    }
  }

  chat = async (message: string, ids: Ids): Promise<[string, Ids]> => {
    // print baseURl
    info(`apiBaseUrl: ${this.options.apiBaseUrl}`)
    let res: [string, Ids] = ['', {}]
    try {
      res = await this.chat_(message, ids)
      return res
    } catch (e: unknown) {
      if (e instanceof ChatGPTError) {
        warning(`Failed to chat: ${e}, backtrace: ${e.stack}`)
      }
      return res
    }
  }

  private readonly chat_ = async (
    message: string,
    ids: Ids
  ): Promise<[string, Ids]> => {
    // record timing
    const start = Date.now()
    if (!message) {
      return ['', {}]
    }

    let response: ChatMessage | undefined

    if (this.api != null) {
      const opts: SendMessageOptions = {
        timeoutMs: this.options.openaiTimeoutMS
      }
      if (ids.parentMessageId) {
        opts.parentMessageId = ids.parentMessageId
      }
      try {
        response = await pRetry(() => this.api!.sendMessage(message, opts), {
          retries: this.options.openaiRetries
        })
      } catch (e: unknown) {
        if (e instanceof ChatGPTError) {
          info(
            `response: ${response}, failed to send message to openai: ${e}, backtrace: ${e.stack}`
          )
        }
      }
      const end = Date.now()
      info(`response: ${JSON.stringify(response)}`)
      info(
        `openai sendMessage (including retries) response time: ${
          end - start
        } ms`
      )
    } else {
      setFailed('The OpenAI API is not initialized')
    }
    let responseText = ''
    if (response != null) {
      responseText = response.text
    } else {
      warning('openai response is null')
    }
    // remove the prefix "with " in the response
    if (responseText.startsWith('with ')) {
      responseText = responseText.substring(5)
    }
    if (this.options.debug) {
      info(`openai responses: ${responseText}`)
    }
    const newIds: Ids = {
      parentMessageId: response?.id,
      conversationId: response?.conversationId
    }
    return [responseText, newIds]
  }
}
