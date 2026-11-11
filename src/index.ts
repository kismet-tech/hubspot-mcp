#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createStatefulServer } from "@smithery/sdk/server/stateful.js"
import { instrumentServer } from "@shinzolabs/instrumentation-mcp"
import { z } from "zod"

function formatResponse(data: any) {
  let text = ''

  if (typeof data === 'string') {
    text = data
  } else if (data === null || data === undefined) {
    text = "No data returned"
  } else if (typeof data === 'object') {
    text = JSON.stringify(data)
  } else {
    text = String(data)
  }

  return { content: [{ type: "text" as const, text }] }
}

async function makeApiRequest(apiKey: string, endpoint: string, params: Record<string, any> = {}, method = 'GET', body: Record<string, any> | null = null) {
  if (!apiKey) {
    throw new Error("HUBSPOT_ACCESS_TOKEN environment variable is not set")
  }

  const queryParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) queryParams.append(key, value.toString())
  })

  const url = `https://api.hubapi.com${endpoint}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  }

  if (body) headers['Content-Type'] = 'application/json'

  const requestOptions: RequestInit = { method, headers }

  if (body) requestOptions.body = JSON.stringify(body)

  const response = await fetch(url, requestOptions)

  if (!response.ok) return `Error fetching data from HubSpot: Status ${response.status}`

  if (response.status === 204) return `Success: Status ${response.status}`

  return await response.json()
}

async function makeApiRequestWithErrorHandling(apiKey: string, endpoint: string, params: Record<string, any> = {}, method = 'GET', body: Record<string, any> | null = null) {
  try {
    const data = await makeApiRequest(apiKey, endpoint, params, method, body)
    return formatResponse(data)
  } catch (error: any) {
    return formatResponse(`Error performing request: ${error.message}`)
  }
}

async function handleEndpoint(apiCall: () => Promise<any>) {
  try {
    return await apiCall()
  } catch (error: any) {
    return formatResponse(error.message)
  }
}

function getConfig(config: any) {
  return {
    hubspotAccessToken: config?.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN,
    telemetryEnabled: config?.TELEMETRY_ENABLED || process.env.TELEMETRY_ENABLED || "true"
  }
}

function createServer({ config }: { config?: any } = {}) {
  const serverInfo = {
    name: "HubSpot-MCP",
    version: "3.0.0",
    description: "HubSpot CRM MCP server with parameterized tools"
  }
  const server = new McpServer(serverInfo)

  const { hubspotAccessToken, telemetryEnabled } = getConfig(config)

  if (telemetryEnabled !== "false") {
    instrumentServer(server, {
      serverName: serverInfo.name,
      serverVersion: serverInfo.version,
      exporterEndpoint: "https://api.otel.shinzo.tech/v1"
    })
  }

  // Shared schemas
  const CRM_OBJECT_TYPES = z.enum([
    'companies', 'contacts', 'deals', 'tickets', 'leads',
    'meetings', 'calls', 'emails', 'notes', 'tasks', 'products'
  ]).describe("HubSpot CRM object type")

  const associationSchema = z.object({
    to: z.object({ id: z.string() }),
    types: z.array(z.object({
      associationCategory: z.string(),
      associationTypeId: z.number()
    }))
  })

  const filterSchema = z.object({
    propertyName: z.string(),
    operator: z.enum([
      'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN',
      'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY',
      'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'
    ]),
    value: z.any().optional(),
    values: z.array(z.any()).optional()
  })

  // ─── Tool 1: crm_list ───

  server.registerTool("crm_list", {
    description: "List CRM objects of any type with optional property selection and pagination",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      limit: z.number().min(1).max(100).optional().describe("Max results per page (1-100)"),
      after: z.string().optional().describe("Paging cursor from previous response"),
      properties: z.array(z.string()).optional().describe("Properties to include in response")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
        limit: params.limit,
        after: params.after,
        properties: params.properties?.join(',')
      })
    })
  })

  // ─── Tool 2: crm_get ───

  server.registerTool("crm_get", {
    description: "Get a single CRM object by ID with optional properties and associations",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      objectId: z.string().describe("The object ID to retrieve"),
      properties: z.array(z.string()).optional().describe("Properties to include"),
      associations: z.array(z.string()).optional().describe("Associated object types to include")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}/${params.objectId}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {
        properties: params.properties?.join(','),
        associations: params.associations?.join(',')
      })
    })
  })

  // ─── Tool 3: crm_create ───

  server.registerTool("crm_create", {
    description: "Create a new CRM object (company, contact, deal, etc.) with properties and optional associations",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      properties: z.record(z.any()).describe("Object properties as key-value pairs"),
      associations: z.array(associationSchema).optional().describe("Associations to other objects")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
        properties: params.properties,
        associations: params.associations
      })
    })
  })

  // ─── Tool 4: crm_update ───

  server.registerTool("crm_update", {
    description: "Update an existing CRM object's properties by ID",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      objectId: z.string().describe("The object ID to update"),
      properties: z.record(z.any()).describe("Properties to update as key-value pairs")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}/${params.objectId}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PATCH', {
        properties: params.properties
      })
    })
  })

  // ─── Tool 5: crm_archive ───

  server.registerTool("crm_archive", {
    description: "Archive (soft-delete) a CRM object by ID",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      objectId: z.string().describe("The object ID to archive")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}/${params.objectId}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
    })
  })

  // ─── Tool 6: crm_search ───

  server.registerTool("crm_search", {
    description: "Search CRM objects with filters, sorting, and property selection",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      filterGroups: z.array(z.object({
        filters: z.array(filterSchema)
      })).describe("Filter groups (OR between groups, AND within a group)"),
      properties: z.array(z.string()).optional().describe("Properties to include in results"),
      limit: z.number().min(1).max(100).optional().describe("Max results (1-100)"),
      after: z.string().optional().describe("Paging cursor"),
      sorts: z.array(z.object({
        propertyName: z.string(),
        direction: z.enum(['ASCENDING', 'DESCENDING'])
      })).optional().describe("Sort order")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}/search`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
        filterGroups: params.filterGroups,
        properties: params.properties,
        limit: params.limit,
        after: params.after,
        sorts: params.sorts
      })
    })
  })

  // ─── Tool 7: crm_batch ───

  server.registerTool("crm_batch", {
    description: "Batch create, read, update, or archive CRM objects (max 100 per request)",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      operation: z.enum(['create', 'read', 'update', 'archive']).describe("Batch operation type"),
      inputs: z.array(z.record(z.any())).describe("Array of objects. Shape depends on operation: create=[{properties}], read=[{id}], update=[{id,properties}], archive=[{id}]"),
      properties: z.array(z.string()).optional().describe("For batch read: properties to return")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/objects/${params.objectType}/batch/${params.operation}`
      const body: Record<string, any> = { inputs: params.inputs }
      if (params.operation === 'read' && params.properties) {
        body.properties = params.properties
      }
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', body)
    })
  })

  // ─── Tool 8: crm_properties_get ───

  server.registerTool("crm_properties_get", {
    description: "Get all properties defined for a CRM object type",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/properties/${params.objectType}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint)
    })
  })

  // ─── Tool 9: crm_property_create ───

  server.registerTool("crm_property_create", {
    description: "Create a new custom property for a CRM object type",
    inputSchema: {
      objectType: CRM_OBJECT_TYPES,
      name: z.string().describe("Internal property name"),
      label: z.string().describe("Display label"),
      type: z.string().describe("Property type: string, number, date, datetime, enumeration, bool"),
      fieldType: z.string().describe("Field type: text, textarea, number, date, select, radio, checkbox"),
      groupName: z.string().describe("Property group name"),
      description: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        value: z.string(),
        displayOrder: z.number().optional()
      })).optional().describe("Options for enumeration properties")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v3/properties/${params.objectType}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
        name: params.name,
        label: params.label,
        type: params.type,
        fieldType: params.fieldType,
        groupName: params.groupName,
        description: params.description,
        options: params.options
      })
    })
  })

  // ─── Tool 10: crm_associate ───

  server.registerTool("crm_associate", {
    description: "Manage associations between CRM objects. Use action 'list_types' to see available association types, 'get' to read associations, 'create' to link objects, 'archive' to unlink.",
    inputSchema: {
      action: z.enum(['list_types', 'get', 'create', 'archive']).describe("Association action"),
      fromObjectType: CRM_OBJECT_TYPES,
      toObjectType: CRM_OBJECT_TYPES,
      fromObjectId: z.string().optional().describe("Source object ID (required for get/create/archive)"),
      toObjectId: z.string().optional().describe("Target object ID (required for create/archive)"),
      associationType: z.string().optional().describe("Association type ID (required for create/archive)")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const { action, fromObjectType, toObjectType, fromObjectId, toObjectId, associationType } = params

      if (action === 'list_types') {
        const endpoint = `/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint)
      }

      if (action === 'get') {
        if (!fromObjectId) return formatResponse("Error: fromObjectId is required for 'get' action")
        const endpoint = `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint)
      }

      if (action === 'create') {
        if (!fromObjectId || !toObjectId) return formatResponse("Error: fromObjectId and toObjectId are required for 'create' action")
        const endpoint = `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}`
        const body = associationType ? [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: Number(associationType) }] : []
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'PUT', body)
      }

      if (action === 'archive') {
        if (!fromObjectId || !toObjectId) return formatResponse("Error: fromObjectId and toObjectId are required for 'archive' action")
        const endpoint = `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}/${toObjectId}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'DELETE')
      }

      return formatResponse("Error: Invalid action")
    })
  })

  // ─── Tool 11: crm_batch_associate ───

  server.registerTool("crm_batch_associate", {
    description: "Batch create or archive associations between CRM objects",
    inputSchema: {
      fromObjectType: CRM_OBJECT_TYPES,
      toObjectType: CRM_OBJECT_TYPES,
      operation: z.enum(['create', 'archive']).describe("Batch operation type"),
      inputs: z.array(z.object({
        from: z.object({ id: z.string() }),
        to: z.object({ id: z.string() }),
        types: z.array(z.object({
          associationCategory: z.string(),
          associationTypeId: z.number()
        })).optional()
      })).describe("Array of association inputs")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const endpoint = `/crm/v4/associations/${params.fromObjectType}/${params.toObjectType}/batch/${params.operation}`
      return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
        inputs: params.inputs
      })
    })
  })

  // ─── Tool 12: communications_preferences ───

  server.registerTool("communications_preferences", {
    description: "Manage HubSpot communication preferences and email subscriptions",
    inputSchema: {
      action: z.enum([
        'get_definitions',
        'get_status',
        'subscribe',
        'unsubscribe'
      ]).describe("Action to perform"),
      email: z.string().optional().describe("Contact email (required for get_status/subscribe/unsubscribe)"),
      subscriptionId: z.string().optional().describe("Subscription ID (required for subscribe/unsubscribe)"),
      legalBasis: z.enum([
        'LEGITIMATE_INTEREST_CLIENT', 'LEGITIMATE_INTEREST_PUB',
        'PERFORMANCE_OF_CONTRACT', 'CONSENT_WITH_NOTICE',
        'CONSENT_WITH_NOTICE_AND_OPT_OUT'
      ]).optional().describe("Legal basis for subscription change")
    }
  }, async (params) => {
    return handleEndpoint(async () => {
      const { action, email, subscriptionId, legalBasis } = params

      if (action === 'get_definitions') {
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, '/communication-preferences/v3/definitions')
      }

      if (action === 'get_status') {
        if (!email) return formatResponse("Error: email is required for get_status")
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, `/communication-preferences/v3/status/email/${email}`)
      }

      if (action === 'subscribe' || action === 'unsubscribe') {
        if (!email || !subscriptionId) return formatResponse("Error: email and subscriptionId are required")
        const endpoint = `/communication-preferences/v3/${action}`
        return await makeApiRequestWithErrorHandling(hubspotAccessToken, endpoint, {}, 'POST', {
          emailAddress: email,
          subscriptionId,
          legalBasis
        })
      }

      return formatResponse("Error: Invalid action")
    })
  })

  // ─── Tool 13: hubspot_info ───

  server.registerTool("hubspot_info", {
    description: "Check HubSpot connection status and server info",
    inputSchema: {}
  }, async () => {
    const hasToken = !!hubspotAccessToken
    const tokenPreview = hasToken ? `${hubspotAccessToken.substring(0, 10)}...` : 'NOT SET'

    let authStatus = 'unknown'
    if (hasToken) {
      try {
        const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
          headers: { 'Authorization': `Bearer ${hubspotAccessToken}`, 'Accept': 'application/json' }
        })
        authStatus = response.ok ? 'authenticated' : `error: ${response.status}`
      } catch (e: any) {
        authStatus = `error: ${e.message}`
      }
    }

    return formatResponse({
      server: { name: serverInfo.name, version: serverInfo.version },
      auth: { hasToken, tokenPreview, status: authStatus }
    })
  })

  return server.server
}

// Stdio Server
const stdioServer = createServer({})
const transport = new StdioServerTransport()
await stdioServer.connect(transport)

// Streamable HTTP Server (only when PORT is explicitly set)
if (process.env.PORT) {
  const { app } = createStatefulServer(createServer)
  app.listen(Number(process.env.PORT))
}
