/**
 * Google Tag Manager - Variables tools
 */

import { z } from 'zod';
import { getGTMClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GTMVariable, GTMParameter } from '../../../types/google.js';

const log = createServiceLogger('gtm-variables');

// Parameter schema for GTM
const gtmParameterSchema: z.ZodType<GTMParameter> = z.lazy(() =>
  z.object({
    type: z.string(),
    key: z.string(),
    value: z.string().optional(),
    list: z.array(gtmParameterSchema).optional(),
    map: z.array(gtmParameterSchema).optional(),
  })
);

// ============================================
// List Variables
// ============================================

const listVariablesSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListVariablesInput = z.infer<typeof listVariablesSchema>;

interface ListVariablesOutput {
  variables: GTMVariable[];
  nextPageToken?: string;
}

export const gtmListVariablesTool: ToolDefinition<ListVariablesInput, ListVariablesOutput> = {
  name: 'gtm_list_variables',
  description: 'Lists all variables in a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: listVariablesSchema,

  async handler(input: ListVariablesInput): Promise<ListVariablesOutput> {
    log.info('Listing GTM variables', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.variables.list({
      parent: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      pageToken: input.pageToken,
    });

    const variables: GTMVariable[] = (response.data.variable || []).map((v) => ({
      accountId: v.accountId || '',
      containerId: v.containerId || '',
      workspaceId: v.workspaceId || '',
      variableId: v.variableId || '',
      name: v.name || '',
      type: v.type || '',
      parameter: (v.parameter || []) as GTMParameter[],
      fingerprint: v.fingerprint || '',
      path: v.path || '',
      tagManagerUrl: v.tagManagerUrl || '',
    }));

    log.info('Listed GTM variables', { count: variables.length });

    return {
      variables,
      nextPageToken: response.data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Get Variable
// ============================================

const getVariableSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  variableId: z.string().describe('GTM Variable ID'),
});

type GetVariableInput = z.infer<typeof getVariableSchema>;

export const gtmGetVariableTool: ToolDefinition<GetVariableInput, GTMVariable> = {
  name: 'gtm_get_variable',
  description: 'Gets a specific variable configuration from GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: getVariableSchema,

  async handler(input: GetVariableInput): Promise<GTMVariable> {
    log.info('Getting GTM variable', input);

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.variables.get({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/variables/${input.variableId}`,
    });

    const v = response.data;

    return {
      accountId: v.accountId || '',
      containerId: v.containerId || '',
      workspaceId: v.workspaceId || '',
      variableId: v.variableId || '',
      name: v.name || '',
      type: v.type || '',
      parameter: (v.parameter || []) as GTMParameter[],
      fingerprint: v.fingerprint || '',
      path: v.path || '',
      tagManagerUrl: v.tagManagerUrl || '',
    };
  },
};

// ============================================
// Create Variable
// ============================================

const createVariableSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  variable: z.object({
    name: z.string().describe('Variable name'),
    type: z.string().describe('Variable type (e.g., v for Data Layer, jsm for Custom JavaScript, c for Constant)'),
    parameter: z.array(gtmParameterSchema).optional().describe('Variable parameters'),
  }),
});

type CreateVariableInput = z.infer<typeof createVariableSchema>;

export const gtmCreateVariableTool: ToolDefinition<CreateVariableInput, GTMVariable> = {
  name: 'gtm_create_variable',
  description: 'Creates a new variable in a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: createVariableSchema,

  async handler(input: CreateVariableInput): Promise<GTMVariable> {
    log.info('Creating GTM variable', { name: input.variable.name, type: input.variable.type });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.variables.create({
      parent: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}`,
      requestBody: {
        name: input.variable.name,
        type: input.variable.type,
        parameter: input.variable.parameter,
      },
    });

    const v = response.data;

    log.info('Created GTM variable', { variableId: v.variableId, name: v.name });

    return {
      accountId: v.accountId || '',
      containerId: v.containerId || '',
      workspaceId: v.workspaceId || '',
      variableId: v.variableId || '',
      name: v.name || '',
      type: v.type || '',
      parameter: (v.parameter || []) as GTMParameter[],
      fingerprint: v.fingerprint || '',
      path: v.path || '',
      tagManagerUrl: v.tagManagerUrl || '',
    };
  },
};

// ============================================
// Update Variable
// ============================================

const updateVariableSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  variableId: z.string().describe('GTM Variable ID'),
  fingerprint: z.string().describe('Variable fingerprint for optimistic locking'),
  variable: z.object({
    name: z.string().optional().describe('New variable name'),
    type: z.string().optional().describe('New variable type'),
    parameter: z.array(gtmParameterSchema).optional().describe('New variable parameters'),
  }),
});

type UpdateVariableInput = z.infer<typeof updateVariableSchema>;

export const gtmUpdateVariableTool: ToolDefinition<UpdateVariableInput, GTMVariable> = {
  name: 'gtm_update_variable',
  description: 'Updates an existing variable in GTM',
  category: ToolCategory.GOOGLE,
  inputSchema: updateVariableSchema,

  async handler(input: UpdateVariableInput): Promise<GTMVariable> {
    log.info('Updating GTM variable', { variableId: input.variableId });

    const gtm = await getGTMClient();

    const response = await gtm.accounts.containers.workspaces.variables.update({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/variables/${input.variableId}`,
      fingerprint: input.fingerprint,
      requestBody: {
        name: input.variable.name,
        type: input.variable.type,
        parameter: input.variable.parameter,
      },
    });

    const v = response.data;

    log.info('Updated GTM variable', { variableId: v.variableId });

    return {
      accountId: v.accountId || '',
      containerId: v.containerId || '',
      workspaceId: v.workspaceId || '',
      variableId: v.variableId || '',
      name: v.name || '',
      type: v.type || '',
      parameter: (v.parameter || []) as GTMParameter[],
      fingerprint: v.fingerprint || '',
      path: v.path || '',
      tagManagerUrl: v.tagManagerUrl || '',
    };
  },
};

// ============================================
// Delete Variable
// ============================================

const deleteVariableSchema = z.object({
  accountId: z.string().describe('GTM Account ID'),
  containerId: z.string().describe('GTM Container ID'),
  workspaceId: z.string().describe('GTM Workspace ID'),
  variableId: z.string().describe('GTM Variable ID to delete'),
});

type DeleteVariableInput = z.infer<typeof deleteVariableSchema>;

interface DeleteVariableOutput {
  success: boolean;
  variableId: string;
}

export const gtmDeleteVariableTool: ToolDefinition<DeleteVariableInput, DeleteVariableOutput> = {
  name: 'gtm_delete_variable',
  description: 'Deletes a variable from a GTM workspace',
  category: ToolCategory.GOOGLE,
  inputSchema: deleteVariableSchema,

  async handler(input: DeleteVariableInput): Promise<DeleteVariableOutput> {
    log.info('Deleting GTM variable', input);

    const gtm = await getGTMClient();

    await gtm.accounts.containers.workspaces.variables.delete({
      path: `accounts/${input.accountId}/containers/${input.containerId}/workspaces/${input.workspaceId}/variables/${input.variableId}`,
    });

    log.info('Deleted GTM variable', { variableId: input.variableId });

    return {
      success: true,
      variableId: input.variableId,
    };
  },
};
