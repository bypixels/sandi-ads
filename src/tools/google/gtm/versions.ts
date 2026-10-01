/**
 * Google Tag Manager - Container Versions tools
 */

import { z } from 'zod';
import { getGTMClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import { MCPError } from '../../../types/errors.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('gtm-versions');

// ============================================
// Types
// ============================================

interface GTMVersion {
  accountId: string;
  containerId: string;
  containerVersionId: string;
  name: string;
  description?: string;
  fingerprint: string;
  path: string;
  tagManagerUrl: string;
}

interface GTMVersionHeader {
  accountId: string;
  containerId: string;
  containerVersionId: string;
  name?: string;
  numTags?: number;
  numTriggers?: number;
  numVariables?: number;
  deleted?: boolean;
  path: string;
}

// ============================================
// List Versions
// ============================================

const listVersionsSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  includeDeleted: z.boolean().optional().describe('Include deleted versions'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListVersionsInput = z.infer<typeof listVersionsSchema>;

interface ListVersionsOutput {
  versions: GTMVersionHeader[];
  nextPageToken?: string;
}

export const gtmListVersionsTool: ToolDefinition<ListVersionsInput, ListVersionsOutput> = {
  name: 'gtm_list_versions',
  description: 'Lists all container versions in GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: listVersionsSchema,

  async handler(input: ListVersionsInput): Promise<ListVersionsOutput> {
    log.info('Listing GTM versions', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.version_headers.list({
      parent: `accounts/${input.accountId}/containers/${input.containerId}`,
      includeDeleted: input.includeDeleted,
      pageToken: input.pageToken,
    });

    const versions: GTMVersionHeader[] = (response.data.containerVersionHeader || []).map((v) => ({
      accountId: v.accountId || '',
      containerId: v.containerId || '',
      containerVersionId: v.containerVersionId || '',
      name: v.name || undefined,
      numTags: v.numTags ? Number(v.numTags) : undefined,
      numTriggers: v.numTriggers ? Number(v.numTriggers) : undefined,
      numVariables: v.numVariables ? Number(v.numVariables) : undefined,
      deleted: v.deleted || undefined,
      path: v.path || '',
    }));

    log.info('Listed GTM versions', { count: versions.length });

    return {
      versions,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Version
// ============================================

const getVersionSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  containerVersionId: z.string().describe('GTM Container Version ID'),
});

type GetVersionInput = z.infer<typeof getVersionSchema>;

export const gtmGetVersionTool: ToolDefinition<GetVersionInput, GTMVersion> = {
  name: 'gtm_get_version',
  description: 'Gets a specific container version from GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: getVersionSchema,

  async handler(input: GetVersionInput): Promise<GTMVersion> {
    log.info('Getting GTM version', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.versions.get({
      path: `accounts/${input.accountId}/containers/${input.containerId}/versions/${input.containerVersionId}`,
    });

    const v = response.data;

    return {
      accountId: v.accountId || '',
      containerId: v.containerId || '',
      containerVersionId: v.containerVersionId || '',
      name: v.name || '',
      description: v.description || undefined,
      fingerprint: v.fingerprint || '',
      path: v.path || '',
      tagManagerUrl: v.tagManagerUrl || '',
    };
  },
};

// ============================================
// Create Version
// ============================================

const createVersionSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID to create version from'),
  name: z.string().describe('Version name'),
  notes: z.string().optional().describe('Version notes/description'),
});

type CreateVersionInput = z.infer<typeof createVersionSchema>;

interface CreateVersionOutput {
  version: GTMVersion;
  compilerError?: boolean;
}

export const gtmCreateVersionTool: ToolDefinition<CreateVersionInput, CreateVersionOutput> = {
  name: 'gtm_create_version',
  description: 'Creates a new container version from a workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: createVersionSchema,

  async handler(input: CreateVersionInput): Promise<CreateVersionOutput> {
    log.info('Creating GTM version', { name: input.name, workspaceId: input.workspaceId });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.create_version({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      requestBody: {
        name: input.name,
        notes: input.notes,
      },
    });

    const v = response.data.containerVersion;

    if (!v) {
      throw MCPError.externalServiceError('gtm', 'Failed to create version - no version returned');
    }

    log.info('Created GTM version', { containerVersionId: v.containerVersionId, name: v.name });

    return {
      version: {
        accountId: v.accountId || '',
        containerId: v.containerId || '',
        containerVersionId: v.containerVersionId || '',
        name: v.name || '',
        description: v.description || undefined,
        fingerprint: v.fingerprint || '',
        path: v.path || '',
        tagManagerUrl: v.tagManagerUrl || '',
      },
      compilerError: response.data.compilerError || false,
    };
  },
};

// ============================================
// Publish Version
// ============================================

const publishVersionSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  containerVersionId: z.string().describe('GTM Container Version ID to publish'),
  fingerprint: z.string().optional().describe('Version fingerprint for optimistic locking'),
});

type PublishVersionInput = z.infer<typeof publishVersionSchema>;

interface PublishVersionOutput {
  version: GTMVersion;
  compilerError?: boolean;
}

export const gtmPublishVersionTool: ToolDefinition<PublishVersionInput, PublishVersionOutput> = {
  name: 'gtm_publish_version',
  description: 'Publishes a container version to make it live',
  category: ToolCategory.GOOGLE,
  inputSchema: publishVersionSchema,

  async handler(input: PublishVersionInput): Promise<PublishVersionOutput> {
    log.info('Publishing GTM version', { containerVersionId: input.containerVersionId });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.versions.publish({
      path: `accounts/${input.accountId}/containers/${input.containerId}/versions/${input.containerVersionId}`,
      fingerprint: input.fingerprint,
    });

    const v = response.data.containerVersion;

    if (!v) {
      throw MCPError.externalServiceError('gtm', 'Failed to publish version - no version returned');
    }

    log.info('Published GTM version', { containerVersionId: v.containerVersionId });

    return {
      version: {
        accountId: v.accountId || '',
        containerId: v.containerId || '',
        containerVersionId: v.containerVersionId || '',
        name: v.name || '',
        description: v.description || undefined,
        fingerprint: v.fingerprint || '',
        path: v.path || '',
        tagManagerUrl: v.tagManagerUrl || '',
      },
      compilerError: response.data.compilerError || false,
    };
  },
};

// ============================================
// Get Live Version
// ============================================

const getLiveVersionSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
});

type GetLiveVersionInput = z.infer<typeof getLiveVersionSchema>;

export const gtmGetLiveVersionTool: ToolDefinition<GetLiveVersionInput, GTMVersion | null> = {
  name: 'gtm_get_live_version',
  description: 'Gets the currently published (live) container version',
  category: ToolCategory.GOOGLE,
  inputSchema: getLiveVersionSchema,

  async handler(input: GetLiveVersionInput): Promise<GTMVersion | null> {
    log.info('Getting GTM live version', input);

    const gtm = await getGTMClient();

    try {
      const response = await gtm.accounts.containers.versions.live({
        parent: `accounts/${input.accountId}/containers/${input.containerId}`,
      });

      const v = response.data;

      if (!v.containerVersionId) {
        return null;
      }

      return {
        accountId: v.accountId || '',
        containerId: v.containerId || '',
        containerVersionId: v.containerVersionId || '',
        name: v.name || '',
        description: v.description || undefined,
        fingerprint: v.fingerprint || '',
        path: v.path || '',
        tagManagerUrl: v.tagManagerUrl || '',
      };
    } catch {
      // No live version
      return null;
    }
  },
};
