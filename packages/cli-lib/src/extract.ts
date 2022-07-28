import {warn, getStdinAsString, debug, writeStdout} from './console_utils'
import {readFile, outputFile} from 'fs-extra'
import {
  interpolateName,
  Opts,
  MessageDescriptor,
} from '@formatjs/ts-transformer'

import {resolveBuiltinFormatter, Formatter} from './formatters'
import stringify from 'json-stable-stringify'
import {parseScript} from './parse_script'
import {printAST} from '@formatjs/icu-messageformat-parser/printer'
import {hoistSelectors} from '@formatjs/icu-messageformat-parser/manipulator'
import {parse} from '@formatjs/icu-messageformat-parser'

import { transform } from 'ember-template-recast';
export interface ExtractionResult<M = Record<string, string>> {
  /**
   * List of extracted messages
   */
  messages: MessageDescriptor[]
  /**
   * Metadata extracted w/ `pragma`
   */
  meta?: M
}

export interface ExtractedMessageDescriptor extends MessageDescriptor {
  /**
   * Line number
   */
  line?: number
  /**
   * Column number
   */
  col?: number
  /**
   * Metadata extracted from pragma
   */
  meta?: Record<string, string>
}

export type ExtractCLIOptions = Omit<
  ExtractOpts,
  'overrideIdFn' | 'onMsgExtracted' | 'onMetaExtracted'
> & {
  /**
   * Output File
   */
  outFile?: string
  /**
   * Ignore file glob pattern
   */
  ignore?: string[]
}

interface ProcessOpts extends Opts {
  idInterpolationPattern?: ExtractOpts['idInterpolationPattern'],
  plugins?: ExtractOpts['plugins'],
  onMsgExtracted?: ExtractOpts['onMsgExtracted'],
}

export class Plugin {
  /**
   * List of file extensions the plugin should run for.
   * e.g. '.hbs'
   */
  extensions: string[] = [];
  source: string;
  fileName: string;
  options: ProcessOpts;


  constructor(source: string, fileName: string, options: ProcessOpts) {
    this.source = source;
    this.fileName = fileName;
    this.options = options;
    
    if (this.extensions.length === 0) {
      throw new Error("Plugin must define extensions field.")
    }

    this.process(source, fileName);
  }

  extractMessage(id?: string, message?: string, description?: string): void {
    let defaultMessage = message && this.trimMessage(message);
    let desc = description && this.trimMessage(description);
    this.options?.onMsgExtracted?.(this.source, [{
      id: this.overrideIdFn(id, defaultMessage, desc) as string,
      description: desc,
      defaultMessage,
    }]);
  }

  process(_source: string, _fileName: string): void {
    throw new Error("Plugin must define process method.")
  }

  overrideIdFn(id?: string, message?: string, description?: string): string | undefined {
    if (typeof this.options.overrideIdFn === 'function') {
      return this.options.overrideIdFn(id, message, description);
    }
  }

  trimMessage(message: string): string {
    return message.trim().replace(/\s+/gm, ' ')
  }
}

class HbsPlugin extends Plugin {
  process(source: string) {
    let extractText = (node: any) => {
      if (node.path.original === 'format-message') {
        let message = node.params[0]?.original
        let desc = node.params[1]?.original
      
        this.extractMessage(undefined, message, desc);
      }
    };

    let visitor = function (): any {
      return {
        MustacheStatement(node: any) {
          extractText(node, fileName, options)
        },
        SubExpression(node: any) {
          extractText(node, fileName, options)
        },
      }
    }

    transform(source, visitor)
  }
}

export type ExtractOpts = Opts & {
  /**
   * Whether to throw an error if we had any issues with
   * 1 of the source files
   */
  throws?: boolean
  /**
   * Message ID interpolation pattern
   */
  idInterpolationPattern?: string
  /**
   * Whether we read from stdin instead of a file
   */
  readFromStdin?: boolean
  /**
   * Path to a formatter file that controls the shape of JSON file from `outFile`.
   */
  format?: string | Formatter
  /**
   * Whether to hoist selectors & flatten sentences
   */
  flatten?: boolean,
  /**
   * Provided extractor plugins
   */
  plugins?: string[]
} & Pick<Opts, 'onMsgExtracted' | 'onMetaExtracted'>

function calculateLineColFromOffset(
  text: string,
  start?: number
): Pick<ExtractedMessageDescriptor, 'line' | 'col'> {
  if (!start) {
    return {line: 1, col: 1}
  }
  const chunk = text.slice(0, start)
  const lines = chunk.split('\n')
  const lastLine = lines[lines.length - 1]
  return {line: lines.length, col: lastLine.length}
}

async function processFile(
  source: string,
  fn: string,
  opts: ProcessOpts
) {
  let messages: ExtractedMessageDescriptor[] = []
  let meta: Record<string, string> | undefined

  opts = {
    ...opts,
    additionalComponentNames: [
      '$formatMessage',
      ...(opts.additionalComponentNames || []),
    ],
    onMsgExtracted(_, msgs) {
      if (opts.extractSourceLocation) {
        msgs = msgs.map(msg => ({
          ...msg,
          ...calculateLineColFromOffset(source, msg.start),
        }))
      }
      messages = messages.concat(msgs)
    },
    onMetaExtracted(_, m) {
      meta = m
    },
  }

  if (!opts.overrideIdFn && opts.idInterpolationPattern) {
    opts = {
      ...opts,
      overrideIdFn: (id, defaultMessage, description, fileName) =>
        id ||
        interpolateName(
          {
            resourcePath: fileName,
          } as any,
          opts.idInterpolationPattern as string,
          {
            content: description
              ? `${defaultMessage}#${
                  typeof description === 'string'
                    ? description
                    : stringify(description)
                }`
              : defaultMessage,
          }
        ),
    }
  }

  debug('Processing opts for %s: %s', fn, opts)

  const scriptParseFn = parseScript(opts, fn)
  
  
  let fileExtension = `.${fn.split('.').pop()}`;
  if (fileExtension === '.vue') {
    debug('Processing %s using vue extractor', fn)
    const {parseFile} = await import('./vue_extractor')
    parseFile(source, fn, scriptParseFn)
  else if (fileExtension === '.hbs') {
    new HbsPlugin(source, fn, opts);
  // if (opts.plugins?.length) {
   // const plugins = await Promise.all(opts.plugins.map(async (plugin) => {
   //   try {
   //     return (await import(plugin)).default as any;
   //   } catch (error) {
   //     throw new Error(`Couldn't load the provided plugin ${plugin}`);
   //   }
   // }));
 
   // const PluginForExtension = plugins.find((Plugin) => Plugin.extensions.includes(fileExtension));

   // if (PluginForExtension) {
   //   new PluginForExtension(source, fn, opts);  
   // }
  }

  } else {
    debug('Processing %s using typescript extractor', fn)
    scriptParseFn(source)
  }
  debug('Done extracting %s messages: %s', fn, messages)
  if (meta) {
    debug('Extracted meta:', meta)
    messages.forEach(m => (m.meta = meta))
  }
  return {messages, meta}
}

/**
 * Extract strings from source files
 * @param files list of files
 * @param extractOpts extract options
 * @returns messages serialized as JSON string since key order
 * matters for some `format`
 */
export async function extract(
  files: readonly string[],
  extractOpts: ExtractOpts
) {
  const {throws, readFromStdin, flatten, ...opts} = extractOpts
  let rawResults: Array<ExtractionResult | undefined>
  if (readFromStdin) {
    debug(`Reading input from stdin`)
    // Read from stdin
    if (process.stdin.isTTY) {
      warn('Reading source file from TTY.')
    }
    const stdinSource = await getStdinAsString()
    rawResults = [await processFile(stdinSource, 'dummy', opts)]
  } else {
    rawResults = await Promise.all(
      files.map(async fn => {
        debug('Extracting file:', fn)
        try {
          const source = await readFile(fn, 'utf8')
          return processFile(source, fn, opts)
        } catch (e) {
          if (throws) {
            throw e
          } else {
            warn(String(e))
          }
        }
      })
    )
  }

  const formatter = await resolveBuiltinFormatter(opts.format)
  const extractionResults = rawResults.filter((r): r is ExtractionResult => !!r)

  const extractedMessages = new Map<string, MessageDescriptor>()

  for (const {messages} of extractionResults) {
    for (const message of messages) {
      const {id, description, defaultMessage} = message
      if (!id) {
        const error = new Error(
          `[FormatJS CLI] Missing message id for message: 
${JSON.stringify(message, undefined, 2)}`
        )
        if (throws) {
          throw error
        } else {
          warn(error.message)
        }
        continue
      }

      if (extractedMessages.has(id)) {
        const existing = extractedMessages.get(id)!
        if (
          stringify(description) !== stringify(existing.description) ||
          defaultMessage !== existing.defaultMessage
        ) {
          const error = new Error(
            `[FormatJS CLI] Duplicate message id: "${id}", ` +
              'but the `description` and/or `defaultMessage` are different.'
          )
          if (throws) {
            throw error
          } else {
            warn(error.message)
          }
        }
      }
      extractedMessages.set(id, message)
    }
  }
  const results: Record<string, Omit<MessageDescriptor, 'id'>> = {}
  const messages = Array.from(extractedMessages.values())
  for (const {id, ...msg} of messages) {
    if (flatten && msg.defaultMessage) {
      msg.defaultMessage = printAST(hoistSelectors(parse(msg.defaultMessage)))
    }
    results[id] = msg
  }
  return stringify(formatter.format(results), {
    space: 2,
    cmp: formatter.compareMessages || undefined,
  })
}

/**
 * Extract strings from source files, also writes to a file.
 * @param files list of files
 * @param extractOpts extract options
 * @returns A Promise that resolves if output file was written successfully
 */
export default async function extractAndWrite(
  files: readonly string[],
  extractOpts: ExtractCLIOptions
) {
  const {outFile, ...opts} = extractOpts
  const serializedResult = (await extract(files, opts)) + '\n'
  if (outFile) {
    debug('Writing output file:', outFile)
    return outputFile(outFile, serializedResult)
  }
  await writeStdout(serializedResult)
}
