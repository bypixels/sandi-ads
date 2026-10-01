/**
 * Google Tag Manager - Accounts, Containers, and Workspaces tools
 */

import { z } from 'zod';
import { getGTMClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GTMAccount, GTMContainer, GTMWorkspace } from '../../../types/google.js';

const log = createServiceLogger('gtm-accounts');

// ============================================
// List Accounts
// ============================================

const listAccountsSchema = z.object({
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page (1-200)'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListAccountsInput = z.infer<typeof listAccountsSchema>;

interface ListAccountsOutput {
  accounts: GTMAccount[];
  nextPageToken?: string;
}

export const gtmListAccountsTool: ToolDefinition<ListAccountsInput, ListAccountsOutput> = {
  name: 'gtm_list_accounts',
  description: 'Lists all Google Tag Manager accounts accessible to the authenticated user',
  category: ToolCategory.GOOGLE,
  inputSchema: listAccountsSchema,

  async handler(input: ListAccountsInput): Promise<ListAccountsOutput> {
    log.info('Listing GTM accounts', { pageSize: input.pageSize });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.list({
      pageToken: input.pageToken,
    });

    const accounts: GTMAccount[] = (response.data.account || []).map((acc) => ({
      accountId: acc.accountId || '',
      name: acc.name || '',
      shareData: acc.shareData || false,
      fingerprint: acc.fingerprint || '',
      path: acc.path || '',
      tagManagerUrl: acc.tagManagerUrl || '',
    }));

    log.info('Listed GTM accounts', { count: accounts.length });

    return {
      accounts,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// List Containers
// ============================================

const listContainersSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListContainersInput = z.infer<typeof listContainersSchema>;

interface ListContainersOutput {
  containers: GTMContainer[];
  nextPageToken?: string;
}

export const gtmListContainersTool: ToolDefinition<ListContainersInput, ListContainersOutput> = {
  name: 'gtm_list_containers',
  description: 'Lists all containers within a GTM account',
  category: ToolCategory.GOOGLE,
  inputSchema: listContainersSchema,

  async handler(input: ListContainersInput): Promise<ListContainersOutput> {
    log.info('Listing GTM containers', { accountId: input.accountId });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.list({
      parent: `accounts/${input.accountId}`,
      pageToken: input.pageToken,
    });

    const containers: GTMContainer[] = (response.data.container || []).map((c) => ({
      accountId: c.accountId || '',
      containerId: c.containerId || '',
      name: c.name || '',
      publicId: c.publicId || '',
      usageContext: c.usageContext || [],
      fingerprint: c.fingerprint || '',
      path: c.path || '',
      tagManagerUrl: c.tagManagerUrl || '',
    }));

    log.info('Listed GTM containers', { count: containers.length });

    return {
      containers,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Container
// ============================================

const getContainerSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
});

type GetContainerInput = z.infer<typeof getContainerSchema>;

export const gtmGetContainerTool: ToolDefinition<GetContainerInput, GTMContainer> = {
  name: 'gtm_get_container',
  description: 'Gets detailed information about a specific GTM container',
  category: ToolCategory.GOOGLE,
  inputSchema: getContainerSchema,

  async handler(input: GetContainerInput): Promise<GTMContainer> {
    log.info('Getting GTM container', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.get({
      path: `accounts/${input.accountId}/containers/${input.containerId}`,
    });

    const c = response.data;

    return {
      accountId: c.accountId || '',
      containerId: c.containerId || '',
      name: c.name || '',
      publicId: c.publicId || '',
      usageContext: c.usageContext || [],
      fingerprint: c.fingerprint || '',
      path: c.path || '',
      tagManagerUrl: c.tagManagerUrl || '',
    };
  },
};

// ============================================
// List Workspaces
// ============================================

const listWorkspacesSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListWorkspacesInput = z.infer<typeof listWorkspacesSchema>;

interface ListWorkspacesOutput {
  workspaces: GTMWorkspace[];
  nextPageToken?: string;
}

export const gtmListWorkspacesTool: ToolDefinition<ListWorkspacesInput, ListWorkspacesOutput> = {
  name: 'gtm_list_workspaces',
  description: 'Lists all workspaces in a GTM container',
  category: ToolCategory.GOOGLE,
  inputSchema: listWorkspacesSchema,

  async handler(input: ListWorkspacesInput): Promise<ListWorkspacesOutput> {
    log.info('Listing GTM workspaces', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.list({
      parent: `accounts/${input.accountId}/containers/${input.containerId}`,
      pageToken: input.pageToken,
    });

    const workspaces: GTMWorkspace[] = (response.data.workspace || []).map((w) => ({
      accountId: w.accountId || '',
      containerId: w.containerId || '',
      workspaceId: w.workspaceId || '',
      name: w.name || '',
      description: w.description || undefined,
      fingerprint: w.fingerprint || '',
      path: w.path || '',
      tagManagerUrl: w.tagManagerUrl || '',
    }));

    log.info('Listed GTM workspaces', { count: workspaces.length });

    return {
      workspaces,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Workspace
// ============================================

const getWorkspaceSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
});

type GetWorkspaceInput = z.infer<typeof getWorkspaceSchema>;

export const gtmGetWorkspaceTool: ToolDefinition<GetWorkspaceInput, GTMWorkspace> = {
  name: 'gtm_get_workspace',
  description: 'Gets detailed information about a specific GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: getWorkspaceSchema,

  async handler(input: GetWorkspaceInput): Promise<GTMWorkspace> {
    log.info('Getting GTM workspace', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.get({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
    });

    const w = response.data;

    return {
      accountId: w.accountId || '',
      containerId: w.containerId || '',
      workspaceId: w.workspaceId || '',
      name: w.name || '',
      description: w.description || undefined,
      fingerprint: w.fingerprint || '',
      path: w.path || '',
      tagManagerUrl: w.tagManagerUrl || '',
    };
  },
};
