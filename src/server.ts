/**
 * MCP Server configuration and setup
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { authManager } from './auth/index.js';
import { createServiceLogger } from './utils/logger.js';
import { rateLimiter } from './utils/rate-limiter.js';
import { cacheStats } from './utils/cache.js';
import { MCPError, ErrorCode } from './types/errors.js';
import { registerAllTools, getAllTools, isToolProGated } from './tools/index.js';
import { zodToJsonSchema } from './utils/schema.js';
import { isPro } from './licensing/index.js';
import { guardedExecute } from './dashboard/services/guarded-execution.js';

const log = createServiceLogger('server');

/** Server metadata */
const SERVER_INFO = {
  name: 'seo-mcp-pro',
  version: '0.1.0',
  description:
    'MCP server for website operations - Google Marketing, SEO, Performance, Security & Monitoring',
};

/**
 * Create and configure the MCP server
 */
export async function createServer(): Promise<Server> {
  log.info('Creating MCP server...', SERVER_INFO);

  // Load stored credentials before auth initialization (Pro only)
  if (isPro()) {
    const { loadStoredCredentials } = await import('./dashboard/index.js');
    // A decryption/configuration failure must stop both transports, not reset the store.
    loadStoredCredentials();
  }

  // Initialize authentication
  await authManager.initialize();

  // Register all tools
  registerAllTools();
  log.info(`Registered ${getAllTools().length} tools`);

  // Create server
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  });

  // Register handlers
  registerToolHandlers(server);
  registerResourceHandlers(server);
  registerPromptHandlers(server);

  // Error handling
  server.onerror = (error) => {
    log.error('Server error', { error: error instanceof Error ? error : new Error(String(error)) });
  };

  log.info('MCP server created successfully');

  return server;
}

/**
 * Register tool handlers
 */
function registerToolHandlers(server: Server): void {
  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.debug('Listing tools');

    // Get all registered tools and convert to MCP format
    const registeredTools = getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    }));

    // Add built-in diagnostic tools
    const builtInTools = [
      {
        name: 'auth_status',
        description: 'Get current authentication status',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
      {
        name: 'cache_stats',
        description: 'Get cache statistics',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
      {
        name: 'rate_limit_status',
        description: 'Get rate limiter status for all services',
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
    ];

    const tools = [...registeredTools, ...builtInTools];

    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    log.info(`Tool called: ${name}`, { args });

    try {
      // Built-in diagnostic tools
      switch (name) {
        case 'auth_status': {
          const status = await authManager.getStatus();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        }

        case 'cache_stats': {
          const stats = cacheStats();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        case 'rate_limit_status': {
          const status = await rateLimiter.getAllStatus();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        }

        default: {
          // Check if tool is Pro-gated
          if (isToolProGated(name)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'PRO_LICENSE_REQUIRED',
                    message: `The tool "${name}" requires an SEO MCP PRO license. Get yours at https://github.com/bypixels/SEO-MCP-PRO`,
                    tool: name,
                  }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const guarded = await guardedExecute(name, args ?? {}, {
            source: { kind: 'mcp' },
          });
          if (guarded.status !== 'success') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(guarded.errorDetails ?? guarded, null, 2),
              }],
              isError: true,
            };
          }
          const result = guarded.result;

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
      }
    } catch (error) {
      log.error(`Tool error: ${name}`, {
        error: error instanceof Error ? error : new Error(String(error)),
      });

      if (error instanceof MCPError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(error.toJSON(), null, 2),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  });
}

/**
 * Register resource handlers
 */
function registerResourceHandlers(server: Server): void {
  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    log.debug('Listing resources');

    const resources = [
      {
        uri: 'site://current',
        name: 'Current Site Configuration',
        description: 'Active site configuration and credentials status',
        mimeType: 'application/json',
      },
      {
        uri: 'credentials://status',
        name: 'Credentials Status',
        description: 'Status of all API credentials and tokens',
        mimeType: 'application/json',
      },
    ];

    return { resources };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    log.debug(`Reading resource: ${uri}`);

    switch (uri) {
      case 'site://current':
        // TODO: Return actual site config
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ message: 'No site configured' }, null, 2),
            },
          ],
        };

      case 'credentials://status': {
        const status = await authManager.getStatus();
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      default:
        throw new MCPError({
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: `Resource not found: ${uri}`,
          retryable: false,
        });
    }
  });
}

/**
 * Register prompt handlers
 */
function registerPromptHandlers(server: Server): void {
  // List available prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    log.debug('Listing prompts');

    const prompts = [
      {
        name: 'seo-analysis',
        description: 'Comprehensive SEO analysis for a website',
        arguments: [
          {
            name: 'url',
            description: 'Website URL to analyze',
            required: true,
          },
        ],
      },
      {
        name: 'performance-review',
        description: 'Performance review with Core Web Vitals analysis',
        arguments: [
          {
            name: 'url',
            description: 'Website URL to analyze',
            required: true,
          },
          {
            name: 'compare_period',
            description: 'Previous period to compare (optional)',
            required: false,
          },
        ],
      },
      {
        name: 'security-audit',
        description: 'Security audit covering SSL, headers, and threats',
        arguments: [
          {
            name: 'url',
            description: 'Website URL to audit',
            required: true,
          },
        ],
      },
    ];

    return { prompts };
  });

  // Get prompt content
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    log.debug(`Getting prompt: ${name}`, { args });

    // TODO: Implement actual prompts
    switch (name) {
      case 'seo-analysis':
        return {
          description: 'Comprehensive SEO analysis',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Please perform a comprehensive SEO analysis for: ${args?.url || '[URL not provided]'}

Include:
1. Technical SEO (robots.txt, sitemap, canonicals)
2. On-page SEO (meta tags, headings, structured data)
3. Performance impact on SEO
4. Mobile-friendliness
5. Recommendations prioritized by impact`,
              },
            },
          ],
        };

      case 'performance-review':
        return {
          description: 'Performance review with Core Web Vitals',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Please review the performance of: ${args?.url || '[URL not provided]'}

Analyze:
1. Core Web Vitals (LCP, FID, CLS, INP, TTFB)
2. PageSpeed scores (mobile and desktop)
3. Performance opportunities
4. Historical trends ${args?.compare_period ? `(comparing with ${args.compare_period})` : ''}
5. Actionable recommendations`,
              },
            },
          ],
        };

      case 'security-audit':
        return {
          description: 'Security audit',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Please perform a security audit for: ${args?.url || '[URL not provided]'}

Check:
1. SSL/TLS configuration
2. Security headers
3. Safe Browsing status
4. Vulnerability assessment
5. Prioritized remediation steps`,
              },
            },
          ],
        };

      default:
        throw new MCPError({
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: `Prompt not found: ${name}`,
          retryable: false,
        });
    }
  });
}

/**
 * Start the server with stdio transport
 */
export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();

  log.info('Starting MCP server with stdio transport...');

  await server.connect(transport);

  log.info('MCP server running');

  // Optionally start the web dashboard (Pro only)
  if (process.env.DASHBOARD_ENABLED === 'true') {
    if (isPro()) {
      const { startDashboard } = await import('./dashboard/index.js');
      await startDashboard();
    } else {
      log.warn(
        'Dashboard requires an SEO MCP PRO license. Get yours at https://github.com/bypixels/SEO-MCP-PRO'
      );
    }
  }
}

export default { createServer, startServer };
