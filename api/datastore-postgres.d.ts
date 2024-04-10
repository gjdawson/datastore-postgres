/// <reference types="node" />

import { ds } from '@eventicle/eventicle-utilities';
import { EventEmitter } from 'events';
import { IDatabase } from 'pg-promise';
import { IMain } from 'pg-promise';
import { Query } from '@eventicle/eventicle-utilities/dist/datastore';

export declare abstract class PsqlEventDataStore<CustomError extends Error> implements ds.DataStore {
    readonly DB: () => IDatabase<any>;
    readonly PGP: () => IMain;
    readonly config: {
        workspaces: boolean;
        logSql?: boolean;
    };
    events: EventEmitter;
    constructor(DB: () => IDatabase<any>, PGP: () => IMain, config: {
        workspaces: boolean;
        logSql?: boolean;
    });
    on(event: "transaction.start" | "transaction.commit", listener: (name: string, data: ds.TransactionData) => void): this;
    tableName(type: any): string;
    getTransactionData(): ds.TransactionData;
    hasTransactionData(): boolean;
    transaction<T>(exec: () => Promise<T>, options?: ds.TransactionOptions): Promise<T>;
    isConnected(): Promise<boolean>;
    maybeLogSql(query: string, params: any): void;
    maybeLogSqlResult(query: string, vals: any[]): void;
    getEntity(workspaceId: string, type: string, id: any): Promise<ds.Record>;
    findEntity(workspaceId: string, type: string, query: ds.Query, sorting?: ds.DataSorting): Promise<ds.Record[]>;
    findEntityPaginated(workspaceId: string, type: string, query: ds.Query, sorting: ds.DataSorting, page: number, pageSize: number): Promise<ds.PagedRecords>;
    createEntity(workspaceId: string, type: string, content: any): Promise<ds.Record>;
    saveEntity(workspaceId: string, type: string, item: ds.Record): Promise<ds.Record>;
    deleteEntity(workspaceId: string, type: string, id: string): Promise<any>;
    deleteMany(workspaceId: string, type: string, query: Query): Promise<void>;
    purge(): Promise<void>;
    private getOrderByClause;
    abstract isCustomError(error: Error): error is CustomError;
    entityMapper: (row: any) => ds.Record;
}

export { }
