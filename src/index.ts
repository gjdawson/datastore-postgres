import {EventEmitter} from "events";
import {als} from "asynchronous-local-storage";
import {baseQuery, buildQueryObject, buildWhere} from './sql-helper';

const stackTrace = require('stack-trace');

import {v4 as uuidv4} from 'uuid';
import {ds, logger} from "@eventicle/eventicle-utilities";
import {getFileNameAndLineNumber} from "@eventicle/eventicle-utilities/dist/logger-util";
import {IDatabase, IMain, ITask} from "pg-promise";

export abstract class PsqlEventDataStore<CustomError extends Error> implements ds.DataStore {

  events = new EventEmitter()

  constructor(readonly DB: () => IDatabase<any>, readonly PGP: () => IMain, readonly config: {
    workspaces: boolean
  }) {
  }

  on(event: "transaction.start" | "transaction.commit", listener: (name: string, data: ds.TransactionData) => void): this {
    this.events.addListener(event, args => {
      listener(event, args)
    })
    return this
  }

  tableName(type: any): string {
    return "datastore"
  }

  getTransactionData(): ds.TransactionData {
    return als.get("transaction.data");
  }

  hasTransactionData(): boolean {
    return !!als.get("transaction.data");
  }

  transaction<T>(exec: () => Promise<T>, options?: ds.TransactionOptions): Promise<T> {
    let file = getFileNameAndLineNumber(3)

    let existingId = als.get("transaction.id")

    if (existingId && options && options.propagation === "requires_new") {
      logger.verbose("Ignoring existing transaction: " + existingId, {location: file})
    } else if (existingId) {
      logger.verbose("Joining existing transaction: " + existingId, {location: file})
      return exec()
    }

    return new Promise((resolve, rej) => {

      als.runWith(async () => {

        let txId = uuidv4()
        const txData = {
          data: {}, id: txId
        } as ds.TransactionData

        try {
          // http://vitaly-t.github.io/pg-promise/Task.html
          let ret = await this.DB().task(async task => { // task is used to ensure we stay on the same connection, not for rollback
            try {
              als.set("transaction", task)
              als.set("transaction.id", txId)
              als.set("transaction.data", txData)
              logger.debug("Started transaction " + als.get("transaction.id"), {location: file})
              this.events.emit("transaction.start", txData)

              try {
                let ret = await exec().catch(reason => {

                  if (this.isCustomError(reason)) {
                    return reason as any;
                  }
                  throw reason
                })
                logger.verbose("Transaction is completed and commits cleanly: " + txId, ret)
                return ret
              } catch (e) {
                logger.verbose("Transaction failed via error and rolls back: " + txId, e)
                throw e
              }
            } finally {
              als.set("transaction", null)
              als.set("transaction.id", null)
              als.set("transaction.data", null)
            }
          }).finally(() => this.events.emit("transaction.commit", txData))

          // this is treated as success to permit the transaction to commit cleanly.
          // Then, propagate as error to the api layer (assuming present)
          if (this.isCustomError(ret)) {
            rej(ret)
          } else {
            resolve(ret)
          }

        } catch (e) {
          rej(e)
        }
      })
    })
  }

  async isConnected(): Promise<boolean> {
    return this.DB().any('select 1+1 as result')
      .then(() => {
        return true
      })
      .catch(err => {
        logger.warn("Failed DB liveness check", err)
        return false
      });
  }

  async getEntity(workspaceId: string, type: string, id: any): Promise<ds.Record> {
    let query = `${baseQuery(type, this.tableName(type), this.config.workspaces)} AND id = ?`;
    let vals = id

    if (this.config.workspaces) {
      query = `${baseQuery(type, this.tableName(type), this.config.workspaces)} AND workspace_id = ? AND id = ?`;
      vals = [workspaceId, id]
    }

    const task: ITask<any> = als.get("transaction");
    var rows = null;
    if (task) {
      rows = await task.oneOrNone(query, vals)
    } else {
      rows = await this.DB().oneOrNone(query, vals);
    }

    if (rows === null || rows.length === 0) {
      return null;
    }

    if (rows.length > 1) {
      throw new Error(`Found more than 1 matching record ${type}/${id}`);
    }

    const row = rows[0];
    return this.entityMapper(row);
  }

  async findEntity(workspaceId: string, type: string, query: {
    [key: string]: string | number | ds.DataQuery
  }, sorting: ds.DataSorting = {}): Promise<ds.Record[]> {

    try {

      const queryString =
        baseQuery(type, this.tableName(type), this.config.workspaces) + ' ' +
        buildWhere(query) + ' ' +
        this.getOrderByClause(sorting);

      const task: ITask<any> = als.get("transaction");
      let rows = [];
      if (task) {
        rows = await task.manyOrNone(queryString, buildQueryObject(query, workspaceId, type))
      } else {
        rows = await this.DB().manyOrNone(queryString, buildQueryObject(query, workspaceId, type));
      }
      return rows.map(this.entityMapper);

    } catch (error) {
      logger.error("Failed to findEntity", {
        message: error.message,
        stack: stackTrace.parse(error).map((val: any) => `${val.getFileName()}:${val.getLineNumber()}`).join("\n")
      });
    }

    return [];
  }

  async findEntityPaginated(workspaceId: string, type: string, query: {
    [key: string]: string | null | ds.DataQuery
  }, sorting: ds.DataSorting, page: number, pageSize: number): Promise<ds.PagedRecords> {


    try {

      const queryString =
        baseQuery(type, this.tableName(type), this.config.workspaces) + ' ' +
        buildWhere(query) + ' ' +
        this.getOrderByClause(sorting);

      const queryObject = buildQueryObject(query, workspaceId, type)

      const queryStringCount = `${queryString}`.replace('select *', 'select count(*)');

      const task: ITask<any> = als.get("transaction");
      // console.info('queryStringCount', queryStringCount);
      const countQuery = task ? task.one(queryStringCount, queryObject) : await this.DB().one(queryStringCount, queryObject);

      const queryStringEntries = `${queryString} ${this.getOrderByClause(sorting)} LIMIT ${pageSize} OFFSET ${page * pageSize}`;
      const entriesQuery = task ? task.manyOrNone(queryStringEntries, queryObject) : await this.DB().many(queryStringEntries, queryObject);

      const [countResult, entriesResult] = await Promise.all([countQuery, entriesQuery]);
      const count = parseInt(countResult.rows[0].count);
      const entries = entriesResult.map(this.entityMapper);

      return {
        totalCount: count,
        entries,
        pageInfo: {
          currentPage: page,
          pageSize
        }
      }

    } catch (error) {
      console.log(error)
      logger.error(JSON.stringify(error));
    }
  }

  async createEntity(workspaceId: string, type: string, content: any): Promise<ds.Record> {

    try {

      if (content.id) {
        throw new Error('ID is set, this is not allowed');
      }

      const createdAt = new Date();
      const id = uuidv4();

      content = {...content, id};

      const data = {
        id,
        type,
        createdat: createdAt,
        content: JSON.parse(JSON.stringify(content))
      };

      let sql
      let params
      if (this.config.workspaces) {
        sql = `INSERT INTO ${this.tableName(type)} (id, workspace_id, type, createdat, content)
               VALUES ($1, $2, $3, $4, $5)`;
        params = [data.id, workspaceId, data.type, data.createdat, data.content];
      } else {
        sql = `INSERT INTO ${this.tableName(type)} (id, type, createdat, content)
               VALUES ($1, $2, $3, $4)`;
        params = [data.id, data.type, data.createdat, data.content];
      }

      const task: ITask<any> = als.get("transaction");
      const res = task ? await task.none(sql, params) : await this.DB().none(sql, params);

      const record = await this.getEntity(workspaceId, type, id);

      if (record !== null) {
        return this.entityMapper(record);
      }

      return null;
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async saveEntity(workspaceId: string, type: string, item: ds.Record): Promise<ds.Record> {
    try {
      const content = {...item.content};
      let condition
      if (this.config.workspaces) {
        condition = this.PGP().as.format(' WHERE id = ${id} and type = ${type} and workspace_id = ${workspaceId}', {
          id: item.id,
          type: type,
          workspaceId
        });
      } else {
        condition = this.PGP().as.format(' WHERE id = ${id} and type = ${type}', {id: item.id, type: type});
      }

      const updateSql = this.PGP().helpers.update({content: content}, null, this.tableName(type)) + condition;

      const task: ITask<any> = als.get("transaction");
      const res = task ? await task.any(updateSql) : await this.DB().any(updateSql);

      return item;

    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async deleteEntity(workspaceId: string, type: string, id: string): Promise<any> {
    try {
      let query = `delete
                   from ${this.tableName(type)}
                   where type = ?
                     and id = ?`;
      let params = [type, id]
      if (this.config.workspaces) {
        query = `delete
                 from ${this.tableName(type)}
                 where type = ?
                   and id = ?
                   and workspace_id = ?`;
        params = [type, id, workspaceId]
      }

      const task: ITask<any> = als.get("transaction");
      const res = task ? await task.any(query, params) : await this.DB().any(query, params);
      return res;
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async purge() {
    try {
      const res1 = await this.DB().any(`truncate datastore`);
      logger.warn("Truncating the datastore", res1)
      const res2 = await this.DB().any(`truncate backupdatastore`);
      logger.warn("Truncating the backupdatastore", res2)
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  private getOrderByClause(sorting: ds.DataSorting) {
    let orderBy = 'ORDER BY ';

    if (sorting && Object.keys(sorting).length > 0) {
      Object.keys(sorting).forEach((value) => {
        if (value == "createdAt") {
          orderBy += `createdat ${sorting[value]},`;
        } else {
          orderBy += `content->>'${value}' ${sorting[value]},`;
        }
      });

      orderBy = orderBy.substring(0, orderBy.length - 1);
    } else {
      orderBy = orderBy + ' id';
    }

    return orderBy;
  }

  abstract isCustomError(error: Error): error is CustomError

  entityMapper: (row: any) => ds.Record = (row) => {
    return {
      id: row.id,
      type: row.type,
      createdAt: row.createdat,
      content: row.content
    };
  }
}
