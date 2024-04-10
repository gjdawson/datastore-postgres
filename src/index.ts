import {EventEmitter} from "events";
import {als} from "asynchronous-local-storage";
import {baseQuery, buildQueryObject, buildWhere} from './sql-helper';
import * as stackTrace from "@eventicle/eventicle-utilities/dist/stack-trace"
import {v4 as uuidv4} from 'uuid';
import {ds, logger, span} from "@eventicle/eventicle-utilities";
import {getFileNameAndLineNumber, maybeRenderError} from "@eventicle/eventicle-utilities/dist/logger-util";
import {IDatabase, IMain, ITask} from "pg-promise";
import {Query} from "@eventicle/eventicle-utilities/dist/datastore";

export abstract class PsqlEventDataStore<CustomError extends Error> implements ds.DataStore {

  events = new EventEmitter()

  constructor(readonly DB: () => IDatabase<any>, readonly PGP: () => IMain, readonly config: {
    workspaces: boolean, logSql?: boolean
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
          let ret = await this.DB().tx(async task => { // task is used to ensure we stay on the same connection, not for rollback
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

  maybeLogSql(query: string, params: any) {
    if (this.config.logSql) {
      logger.info(`SQL: ${query} ${JSON.stringify(params)}`)
    }
  }
  maybeLogSqlResult(query: string, vals: any[]) {
    if (this.config.logSql) {
      logger.info(`RESULT: ${query} ==> ${ vals && vals.length} `)
    }
  }

  async getEntity(workspaceId: string, type: string, id: any): Promise<ds.Record> {
    let query = `${baseQuery(type, this.tableName(type), this.config.workspaces)} AND id = $[id]`;
    let vals = { xxx_type: type, id } as any

    if (this.config.workspaces) {
      query = `${baseQuery(type, this.tableName(type), this.config.workspaces)} AND id = $[id]`;
      vals = { xxx_type: type, xxx_workspaceId: workspaceId, id }
    }

    const task: ITask<any> = als.get("transaction");
    var rows = null;

    this.maybeLogSql(query, vals)
    if (task) {
      rows = await task.oneOrNone(query, vals)
    } else {
      rows = await this.DB().oneOrNone(query, vals);
    }
    this.maybeLogSqlResult(query, rows)

    if (rows === null) {
      return null;
    }

    return this.entityMapper(rows);
  }

  async findEntity(workspaceId: string, type: string, query: ds.Query, sorting: ds.DataSorting = {}): Promise<ds.Record[]> {

    try {
      const queryString =
        baseQuery(type, this.tableName(type), this.config.workspaces) + ' ' +
        buildWhere(query) + ' ' +
        this.getOrderByClause(sorting);

      const task: ITask<any> = als.get("transaction");
      let rows = [];
      const queryObject = buildQueryObject(query, workspaceId, type)
      this.maybeLogSql(queryString, queryObject)
      if (task) {
        await span("Task/ TX Based Query", {}, async () => {
          rows = await task.manyOrNone(queryString, queryObject)
        })
      } else {
        await span("Raw/ NONTX Query", {}, async () => {
          rows = await this.DB().manyOrNone(queryString, queryObject);
        })
      }
      this.maybeLogSqlResult(queryString, rows)
      return rows.map(this.entityMapper);

    } catch (error) {
      logger.error("Failed to findEntity", {
        message: error.message, query: query, type,
        stack: stackTrace.parse(error).map((val: any) => `${val.getFileName()}:${val.getLineNumber()}`).join("\n")
      });
    }

    return [];
  }

  async findEntityPaginated(workspaceId: string, type: string, query: ds.Query, sorting: ds.DataSorting, page: number, pageSize: number): Promise<ds.PagedRecords> {

    try {
      // We don't want to try and sort and limit unless we actually have numbers to work with.

      let sortlimit: string = "";
      let offset: number = 0;

      if(pageSize && pageSize > 0) {
        sortlimit = `LIMIT ${pageSize}`
      }

      if(page) {
        offset = (page * pageSize) - pageSize
        if( offset < 0) {
          offset = 0
        }
        sortlimit = `${sortlimit} OFFSET ${offset}`
      }

      const queryString =
        `${baseQuery(type, this.tableName(type), this.config.workspaces) + ' ' +
        buildWhere(query) + ' ' +
        this.getOrderByClause(sorting)} ${sortlimit}`.replace('select *', 'select *, count(*) over() as count');

      const task: ITask<any> = als.get("transaction");
      let rows = [];
      const queryObject = buildQueryObject(query, workspaceId, type)
      this.maybeLogSql(queryString, queryObject)
      if (task) {
        rows = await task.manyOrNone(queryString, queryObject)
      } else {
        rows = await this.DB().manyOrNone(queryString, queryObject);
      }
      this.maybeLogSqlResult(queryString, rows)

      const count = rows.length === 0 ? 0: parseInt(rows[0].count);
      const entries = rows.map(this.entityMapper);

      return {
        totalCount: count,
        entries,
        pageInfo: {
          currentPage: page,
          pageSize
        }
      }

    } catch (error) {
      logger.error("Query Error?", maybeRenderError(error));
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

      this.maybeLogSql(sql, params)

      const res = task ? await task.manyOrNone(sql, params) : await this.DB().manyOrNone(sql, params);

      this.maybeLogSqlResult(sql, res)

      const record = await this.getEntity(workspaceId, type, id);

      if (record !== null) {
        return record;
      }

      return null;
    } catch (error) {
      logger.error("Error creating entity", error);
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

      this.maybeLogSql(updateSql, {})
      const task: ITask<any> = als.get("transaction");
      const res = task ? await task.any(updateSql) : await this.DB().any(updateSql);

      this.maybeLogSqlResult(updateSql, res)

      return item;

    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async deleteEntity(workspaceId: string, type: string, id: string): Promise<any> {
    try {
      let query = `delete
                   from ${this.tableName(type)}
                   where type = $[type]
                     and id = $[id]`;
      let params = { type, id } as any
      if (this.config.workspaces) {
        query = `delete
                 from ${this.tableName(type)}
                 where type = $[type]
                   and id = $[id]
                   and workspace_id = $[workspaceId]`;
        params ={ type, id, workspaceId }
      }

      this.maybeLogSql(query, params)
      const task: ITask<any> = als.get("transaction");
      const res = task ? await task.any(query, params) : await this.DB().any(query, params);
      this.maybeLogSqlResult(query, res)
      return res;
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  async deleteMany(workspaceId: string, type: string, query: Query): Promise<void> {
    try {
      let queryString = `delete
                         from ${this.tableName(type)}
                         where type = $[xxx_type]
                           ${buildWhere(query)}`

      if (this.config.workspaces) {
        queryString = `delete
                       from ${this.tableName(type)}
                       where type = $[xxx_type]
                         and workspace_id = $[xxx_workspaceId] ${buildWhere(query)}`

      }

      const queryObject = buildQueryObject(query, workspaceId, type)
      const task: ITask<any> = als.get("transaction");
      let res:any;
      this.maybeLogSql(queryString, queryObject)
      if (task) {
        res = await task.any(queryString, queryObject)
      } else {
        res = await this.DB().any(queryString, queryObject);
      }

      this.maybeLogSqlResult(queryString, res)

    } catch (e) {
      logger.error(JSON.stringify(e));
    }

    return void(0)
  }

  async purge() {
    try {
      logger.warn("Truncating the datastore")
      const res1 = await this.DB().any(`truncate datastore`);
      const res2 = await this.DB().any(`truncate backupdatastore`);
      logger.warn("Truncating the backupdatastore", res2)
    } catch (error) {
      logger.error(JSON.stringify(error));
    }
  }

  private getOrderByClause(sorting: ds.DataSorting) {
    let orderBy = 'ORDER BY ';

    const orders = []

    if (sorting && Object.keys(sorting).length > 0) {
      Object.keys(sorting).forEach((value) => {
        if (value == "createdAt") {
          orders.push(`createdat ${sorting[value]}`);
        } else {
          orders.push(`content->>'${value}' ${sorting[value]}`);
        }
      });
    } else {
      orders.push("id")
    }

    return `ORDER BY ${orders.join(", ")}`;

    // return orderBy;
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
