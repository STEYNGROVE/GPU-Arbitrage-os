import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.ts';
import { systemMemoryService } from './systemMemoryService.ts';
import { gpuArbitrageService } from './gpuArbitrageService.ts';
import { verifiedOpportunityEngine } from './verifiedOpportunityEngine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export interface ChatGptRepoStatus {
  service: string;
  version: string;
  timestamp: string;
  github: {
    targetRepo: string;
    branch: string;
    htmlUrl: string;
    isPublic: boolean;
    tokenConfigured: boolean;
    latestCommit?: {
      sha: string;
      message: string;
      author: string;
      date: string;
    };
    stargazersCount: number;
    openIssuesCount: number;
  };
  chatGptIntegration: {
    status: 'ACTIVE' | 'DEGRADED';
    openapiSchemaUrl: string;
    actionAuthentication: 'NONE' | 'BEARER_TOKEN';
    capabilities: string[];
    documentation: string;
  };
}

export class ChatGptGithubService {
  private targetRepo: string = 'STEYNGROVE/gpu-compute-arbitrage-os-and-connect-it-to-Render.';
  private defaultBranch: string = 'main';

  constructor() {
    if (process.env.GITHUB_TARGET_REPO) {
      this.targetRepo = process.env.GITHUB_TARGET_REPO;
    }
  }

  public getTargetRepo(): string {
    return this.targetRepo;
  }

  public setTargetRepo(repo: string): void {
    if (repo && repo.includes('/')) {
      this.targetRepo = repo.trim();
    }
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'GPU-Arbitrage-OS-ChatGPT-Bridge/1.0',
      Accept: 'application/vnd.github.v3+json',
    };
    if (config.github.token) {
      headers['Authorization'] = `Bearer ${config.github.token}`;
    }
    return headers;
  }

  /**
   * Fetches real repository status and metadata from GitHub REST API
   */
  public async getStatus(baseUrl?: string): Promise<ChatGptRepoStatus> {
    const appBaseUrl = baseUrl || config.appUrl || 'http://localhost:3000';
    let stargazers = 0;
    let openIssues = 0;
    let isPublic = true;
    let latestCommit: ChatGptRepoStatus['github']['latestCommit'] = undefined;

    try {
      const repoRes = await fetch(`https://api.github.com/repos/${this.targetRepo}`, {
        headers: this.getAuthHeaders(),
      });
      if (repoRes.ok) {
        const repoData = (await repoRes.json()) as any;
        stargazers = repoData.stargazers_count ?? 0;
        openIssues = repoData.open_issues_count ?? 0;
        isPublic = !repoData.private;
        this.defaultBranch = repoData.default_branch || 'main';
      }
    } catch (err: any) {
      console.warn('[ChatGPT-GitHub Bridge] Repo fetch note:', err.message);
    }

    try {
      const commitRes = await fetch(
        `https://api.github.com/repos/${this.targetRepo}/commits/${this.defaultBranch}`,
        { headers: this.getAuthHeaders() }
      );
      if (commitRes.ok) {
        const commitData = (await commitRes.json()) as any;
        latestCommit = {
          sha: commitData.sha ? commitData.sha.substring(0, 7) : 'unknown',
          message: commitData.commit?.message?.split('\n')[0] || 'Production release',
          author: commitData.commit?.author?.name || 'doppie104',
          date: commitData.commit?.author?.date || new Date().toISOString(),
        };
      }
    } catch (err: any) {
      console.warn('[ChatGPT-GitHub Bridge] Commit fetch note:', err.message);
    }

    return {
      service: 'ChatGPT-GitHub Autonomous Integration Engine',
      version: 'v13-p14',
      timestamp: new Date().toISOString(),
      github: {
        targetRepo: this.targetRepo,
        branch: this.defaultBranch,
        htmlUrl: `https://github.com/${this.targetRepo}`,
        isPublic,
        tokenConfigured: Boolean(config.github.token),
        latestCommit,
        stargazersCount: stargazers,
        openIssuesCount: openIssues,
      },
      chatGptIntegration: {
        status: 'ACTIVE',
        openapiSchemaUrl: `${appBaseUrl}/api/chatgpt/openapi.json`,
        actionAuthentication: isPublic ? 'NONE' : 'BEARER_TOKEN',
        capabilities: [
          'read_repository_structure',
          'read_source_files',
          'query_commit_history',
          'query_arbitrage_opportunities',
          'submit_code_audits',
        ],
        documentation: 'https://platform.openai.com/docs/actions',
      },
    };
  }

  /**
   * Fetches the recent commit history from GitHub
   */
  public async getRecentCommits(limit = 10): Promise<any[]> {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${this.targetRepo}/commits?per_page=${limit}&sha=${this.defaultBranch}`,
        { headers: this.getAuthHeaders() }
      );
      if (res.ok) {
        const data = (await res.json()) as any[];
        return data.map((c) => ({
          sha: c.sha ? c.sha.substring(0, 7) : '',
          fullSha: c.sha,
          message: c.commit?.message || '',
          author: c.commit?.author?.name || c.author?.login || 'Unknown',
          date: c.commit?.author?.date || '',
          htmlUrl: c.html_url,
        }));
      }
    } catch (err: any) {
      console.warn('[ChatGPT-GitHub Bridge] Commits list error:', err.message);
    }
    return [];
  }

  /**
   * Reads a sanitized source code file directly from the repo tree
   */
  public getFileContent(filePath: string): { success: boolean; path: string; content?: string; error?: string } {
    // Sanitize against directory traversal attacks
    const normalized = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absolutePath = path.resolve(ROOT_DIR, normalized);

    if (!absolutePath.startsWith(ROOT_DIR)) {
      return { success: false, path: filePath, error: 'Access denied: Path traversal outside repository root.' };
    }

    // Never return real secret files
    const forbidden = ['.env', '.env.local', '.env.production', 'bun.lock'];
    if (forbidden.some((f) => normalized.endsWith(f))) {
      return { success: false, path: filePath, error: 'Access denied: Protected security file.' };
    }

    try {
      if (!fs.existsSync(absolutePath)) {
        return { success: false, path: filePath, error: 'File not found in repository.' };
      }
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        return { success: false, path: filePath, error: 'Specified path is a directory.' };
      }
      if (stat.size > 2 * 1024 * 1024) {
        return { success: false, path: filePath, error: 'File exceeds 2MB read limit.' };
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      return { success: true, path: normalized, content };
    } catch (err: any) {
      return { success: false, path: filePath, error: err.message };
    }
  }

  /**
   * Returns list of repository files
   */
  public getRepositoryTree(): string[] {
    const results: string[] = [];
    const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.npm']);

    function walk(dir: string, rel: string) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (ignored.has(item.name) || item.name.startsWith('tsx-') || item.name.endsWith('.pipe')) continue;
        const itemRel = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(path.join(dir, item.name), itemRel);
        } else {
          results.push(itemRel);
        }
      }
    }

    walk(ROOT_DIR, '');
    return results.sort();
  }

  /**
   * Generates OpenAPI 3.1.0 specification for ChatGPT Custom GPT Actions
   */
  public generateOpenApiSpec(serverUrl?: string): object {
    const url = serverUrl || config.appUrl || 'http://localhost:3000';

    return {
      openapi: '3.1.0',
      info: {
        title: 'GPU Compute Arbitrage OS - GitHub Bridge API',
        description:
          'Official ChatGPT Action schema connecting ChatGPT to the GPU Compute Arbitrage OS and its GitHub repository (STEYNGROVE/gpu-compute-arbitrage-os-and-connect-it-to-Render.). Enables real-time code inspection, commit tracking, arbitrage telemetry, and architecture verification.',
        version: '1.0.0',
      },
      servers: [
        {
          url,
          description: 'Production GPU Compute Arbitrage OS Server',
        },
      ],
      paths: {
        '/api/chatgpt/status': {
          get: {
            operationId: 'getSystemAndRepoStatus',
            summary: 'Get repository health, branch, and system status',
            description:
              'Returns current GitHub connection status, branch information, latest commit SHA, and arbitrage engine state.',
            responses: {
              '200': {
                description: 'Repository status retrieved successfully',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        service: { type: 'string' },
                        version: { type: 'string' },
                        timestamp: { type: 'string' },
                        github: { type: 'object' },
                        chatGptIntegration: { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/chatgpt/commits': {
          get: {
            operationId: 'listRepositoryCommits',
            summary: 'List recent commits from GitHub main branch',
            description: 'Returns the most recent commits from the repository main branch.',
            parameters: [
              {
                name: 'limit',
                in: 'query',
                description: 'Number of commits to return (max 25)',
                required: false,
                schema: { type: 'integer', default: 10 },
              },
            ],
            responses: {
              '200': {
                description: 'List of commits',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        commits: { type: 'array', items: { type: 'object' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/chatgpt/file': {
          get: {
            operationId: 'readRepositoryFile',
            summary: 'Read a source code or config file from the repository',
            description: 'Retrieves the text content of a source file from the workspace.',
            parameters: [
              {
                name: 'path',
                in: 'query',
                required: true,
                description: 'Relative path of the file (e.g., server.ts, Dockerfile, package.json)',
                schema: { type: 'string' },
              },
            ],
            responses: {
              '200': {
                description: 'File contents returned',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        path: { type: 'string' },
                        content: { type: 'string' },
                        error: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/chatgpt/tree': {
          get: {
            operationId: 'listRepositoryTree',
            summary: 'List all files in the repository directory tree',
            description: 'Returns the full list of files available in the repository.',
            responses: {
              '200': {
                description: 'Repository file list',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        totalFiles: { type: 'integer' },
                        files: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/chatgpt/opportunities': {
          get: {
            operationId: 'listArbitrageOpportunities',
            summary: 'Get active GPU compute arbitrage opportunities and market spreads',
            description: 'Returns verified and simulated GPU compute price differentials across providers.',
            responses: {
              '200': {
                description: 'Arbitrage opportunities list',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        verifiedCount: { type: 'integer' },
                        verifiedOpportunities: { type: 'array', items: { type: 'object' } },
                        benchmarkQuotesCount: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '/api/chatgpt/audit-note': {
          post: {
            operationId: 'submitAuditNote',
            summary: 'Record an AI audit finding or architectural note',
            description: 'Allows ChatGPT to store an architectural review or audit note in the system memory.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['author', 'category', 'finding'],
                    properties: {
                      author: { type: 'string', example: 'ChatGPT Code Auditor' },
                      category: {
                        type: 'string',
                        enum: ['SECURITY', 'PERFORMANCE', 'GAAP_COMPLIANCE', 'DEPLOYMENT', 'ARCHITECTURE'],
                        example: 'DEPLOYMENT',
                      },
                      finding: { type: 'string', example: 'Verified Render build command and port binding to 0.0.0.0:3000.' },
                    },
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Audit note recorded',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean' },
                        id: { type: 'string' },
                        timestamp: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }
}

export const chatGptGithubService = new ChatGptGithubService();
