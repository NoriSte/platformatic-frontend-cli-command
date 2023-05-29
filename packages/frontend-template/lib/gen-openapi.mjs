import CodeBlockWriter from 'code-block-writer'
import jsonpointer from 'jsonpointer'
import { generateOperationId } from '@platformatic/client'
import { capitalize, classCase } from './utils.mjs'
import { STATUS_CODES } from 'node:http'

export function processOpenAPI ({ schema, name, url, language }) {
  return {
    types: generateTypesFromOpenAPI({ schema, name }),
    implementation: generateFrontendImplementationFromOpenAPI({ schema, name, url, language })
  }
}

function generateFrontendImplementationFromOpenAPI ({ schema, name, url, language }) {
  const capitalizedName = capitalize(name)
  const { paths } = schema

  const operations = Object.entries(paths).flatMap(([path, methods]) => {
    return Object.entries(methods).map(([method, operation]) => {
      return {
        path,
        method,
        operation: {
          ...operation,
          operationId: generateOperationId(path, method, operation)
        }
      }
    })
  })

  /* eslint-disable new-cap */
  const writer = new CodeBlockWriter({
    indentNumberOfSpaces: 2,
    useTabs: false,
    useSingleQuote: true
  })

  writer.conditionalWriteLine(language === 'ts', `import type { ${capitalizedName} } from './${name}-types'`)
  writer.blankLine()

  writer.write('const url = ').quote().write(url).quote()
  writer.blankLine()

  for (const operation of operations) {
    const { operationId, responses } = operation.operation
    const { method, path } = operation

    // Only dealing with success responses
    const successResponses = Object.entries(responses).filter(([s]) => s.startsWith('2'))

    // The following block it's impossible to happen with well-formed
    // OpenAPI.
    /* c8 ignore next 3 */
    if (successResponses.length === 0) {
      throw new Error(`Could not find a 200 level response for ${operationId}`)
    }

    if (language === 'ts') {
      // Write
      //
      // ```ts
      // export const getMovies:Api['getMovies'] = async (request) => {
      // ```
      writer.write(
          `export const ${operationId}: ${capitalizedName}['${operationId}'] = async (request) =>`
      )
    } else {
      // The JS version uses the JSDoc type format to offer IntelliSense autocompletion to the developer.
      //
      // ```js
      // /** @type {import('./api-types.d.ts').Api['getMovies']} */
      // export const getMovies = async (request) => {
      // ```
      //
      writer.writeLine(
        `/**  @type {import('./api-types.d.ts').Api['${operationId}']} */`
      ).write(`export const ${operationId} = async (request) =>`)
    }

    writer.block(() => {
      // Transform
      // /organizations/{orgId}/members/{memberId}
      // to
      // /organizations/${request.orgId}/members/${request.memberId}
      const stringLiteralPath = path.replace(/\{/gm, '${request.')

      // GET methods need query strings instead of JSON bodies
      if (method === 'get') {
        writer.writeLine(
          `const response = await fetch(\`\${url}${stringLiteralPath}?\${new URLSearchParams(Object.entries(request)).toString()}\`)`
        )
      } else {
        writer
          .write(`const response = await fetch(\`\${url}${stringLiteralPath}\`, `)
          .inlineBlock(() => {
            writer.write('method:').quote().write(method).quote().write(',')
            writer.writeLine('body: JSON.stringify(request),')
            writer.write('headers:').block(() => {
              writer
                .quote()
                .write('Content-Type')
                .quote()
                .write(': ')
                .quote()
                .write('application/json')
                .quote()
            })
          })
          .write(')')
      }

      writer.blankLine()

      writer.write('if (!response.ok)').block(() => {
        writer.writeLine('throw new Error(await response.text())')
      })

      writer.blankLine()

      writer.writeLine('return await response.json()')
    })
    writer.blankLine()
  }

  return writer.toString()
}

function generateTypesFromOpenAPI ({ schema, name }) {
  const capitalizedName = capitalize(name)
  const { paths } = schema

  const operations = Object.entries(paths).flatMap(([path, methods]) => {
    return Object.entries(methods).map(([method, operation]) => {
      return {
        path,
        method,
        operation: {
          ...operation,
          operationId: generateOperationId(path, method, operation)
        }
      }
    })
  })
  /* eslint-disable new-cap */
  const writer = new CodeBlockWriter({
    indentNumberOfSpaces: 2,
    useTabs: false,
    useSingleQuote: true
  })

  const interfaces = new CodeBlockWriter({
    indentNumberOfSpaces: 2,
    useTabs: false,
    useSingleQuote: true
  })
  /* eslint-enable new-cap */

  writer.write(`export interface ${capitalizedName}`).block(() => {
    for (const operation of operations) {
      const operationId = operation.operation.operationId
      const { parameters, responses, requestBody } = operation.operation
      const operationRequestName = `${capitalize(operationId)}Request`
      const operationResponseName = `${capitalize(operationId)}Response`
      interfaces.write(`interface ${operationRequestName}`).block(() => {
        const addedProps = new Set()
        if (parameters) {
          for (const parameter of parameters) {
            const { name, schema, required } = parameter
            // We do not check for addedProps here because it's the first
            // group of properties
            writeProperty(interfaces, name, schema, addedProps, required)
          }
        }
        if (requestBody) {
          writeContent(interfaces, requestBody.content, schema, addedProps)
        }
      })
      interfaces.writeLine()

      // Only dealing with success responses
      const successResponses = Object.entries(responses).filter(([s]) => s.startsWith('2'))
      // The following block it's impossible to happen with well-formed
      // OpenAPI.
      /* c8 ignore next 3 */
      if (successResponses.length === 0) {
        throw new Error(`Could not find a 200 level response for ${operationId}`)
      }
      const responseTypes = successResponses.map(([statusCode, response]) => {
        // The client library will always dump bodies for 204 responses
        // so the type must be undefined
        if (statusCode === '204') {
          return 'undefined'
        }
        let isResponseArray
        let type = `${operationResponseName}${classCase(STATUS_CODES[statusCode])}`
        interfaces.write(`interface ${type}`).block(() => {
          isResponseArray = writeContent(interfaces, response.content, schema, new Set())
        })
        interfaces.blankLine()
        if (isResponseArray) type = `Array<${type}>`
        return type
      })

      const responseType = responseTypes.join(' | ')
      writer.writeLine(`${operationId}(req: ${operationRequestName}): Promise<${responseType}>;`)
    }
  })

  writer.blankLine()

  return interfaces.toString() + writer.toString()
}

function writeContent (writer, content, spec, addedProps) {
  let isResponseArray = false
  if (content) {
    for (const [contentType, body] of Object.entries(content)) {
      // We ignore all non-JSON endpoints for now
      // TODO: support other content types
      /* c8 ignore next 3 */
      if (contentType.indexOf('application/json') !== 0) {
        continue
      }

      // Response body has no schema that can be processed
      // Should not be possible with well formed OpenAPI
      /* c8 ignore next 3 */
      if (!body.schema?.type && !body.schema?.$ref) {
        break
      }

      // This is likely buggy as there can be multiple responses for different
      // status codes. This is currently not possible with Platformatic DB
      // services so we skip for now.
      // TODO: support different schemas for different status codes
      if (body.schema.type === 'array') {
        isResponseArray = true
        writeObjectProperties(writer, body.schema.items, spec, addedProps)
      } else {
        writeObjectProperties(writer, body.schema, spec, addedProps)
      }
      break
    }
  }
  return isResponseArray
}

function writeObjectProperties (writer, schema, spec, addedProps) {
  if (schema.$ref) {
    schema = jsonpointer.get(spec, schema.$ref.replace('#', ''))
  }
  if (schema.type === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (addedProps.has(key)) {
        continue
      }
      const required = schema.required && schema.required.includes(key)
      writeProperty(writer, key, value, addedProps, required)
    }
    // This is unlikely to happen with well-formed OpenAPI.
    /* c8 ignore next 3 */
  } else {
    throw new Error(`Type ${schema.type} not supported`)
  }
}

function writeProperty (writer, key, value, addedProps, required = true) {
  addedProps.add(key)
  if (required) {
    writer.quote(key)
  } else {
    writer.quote(key)
    writer.write('?')
  }
  if (value.type === 'array') {
    writer.write(`: Array<${JSONSchemaToTsType(value.items.type)}>;`)
  } else {
    writer.write(`: ${JSONSchemaToTsType(value.type)};`)
  }
  writer.newLine()
}

function JSONSchemaToTsType (type) {
  switch (type) {
    case 'string':
      return 'string'
    case 'integer':
      return 'number'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    // TODO what other types should we support here?
    /* c8 ignore next 2 */
    default:
      return 'any'
  }
}
