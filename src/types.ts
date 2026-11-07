export interface Workspace { id: string; name: string }
export interface Project { id: string; name: string; path: string; workspace_id: string }
export interface Database { version: number; workspaces: Workspace[]; projects: Project[] }
export interface ToolStatus { name: string; available: boolean; path: string | null }
export interface FileEntry { name: string; path: string; directory: boolean }
export type Page = 'projects' | 'editor' | 'git' | 'docker' | 'database' | 'settings';
