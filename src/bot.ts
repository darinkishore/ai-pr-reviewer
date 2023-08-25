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
  init?: RequestInit
): Promise<Response> {
  // Check if input is a string or a Request object
  if (typeof input === 'string') {
    // Modify the URL
    const newUrl = `${input}?api-version=2023-03-15-preview`

    // Modify the headers
    init = init || {}
    init.headers = init.headers || new Headers()
    ;(init.headers as Headers).set('api-key', process.env.AZURE_API_KEY || '')
    ;(init.headers as Headers).delete('Authorization')
    ;(init.headers as Headers).delete('OpenAI-Organization')

    // Log debug information
    info(`Sending request to: ${newUrl}`)
    info(
      `With headers: ${JSON.stringify(
        Object.fromEntries(init.headers as Headers),
        null,
        2
      )}`
    )

    return fetch(newUrl, init)
  } else if (input instanceof Request) {
    // Modify the Request object's URL and headers
    input.url = `${input.url}?api-version=2023-03-15-preview`
    input.headers.set('api-key', process.env.AZURE_API_KEY || '')
    input.headers.delete('Authorization')
    input.headers.delete('OpenAI-Organization')

    // Log debug information
    info(`Sending request to: ${input.url}`)
    info(
      `With headers: ${JSON.stringify(
        Object.fromEntries(input.headers),
        null,
        2
      )}`
    )

    return fetch(input, init)
  } else {
    throw new Error('Invalid input type for customFetch function.')
  }
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
