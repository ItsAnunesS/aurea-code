export type Engine = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
export interface DbConnection { id: string; project_id: string; name: string; engine: Engine; host: string; port: number; database: string; username: string; tls: boolean; saved_password: boolean }
export interface DbTable { schema: string; name: string; kind: string }
export interface DbColumn { name: string; data_type: string; primary_key: boolean; nullable: boolean; editable: boolean }
export interface ResultSet { columns: string[]; rows: (string | null)[][]; affected: number; truncated: boolean }
export interface TableData { columns: DbColumn[]; data: ResultSet; editable: boolean }
export interface DatabaseTool { action: 'pull' | 'install-native' | 'native-console' | 'docker-console'; engine: Engine; version: string; connection_id: string | null }
