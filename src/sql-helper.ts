import {DataQuery} from "@eventicle/eventicle-utilities/dist/datastore";
import {isNumeric} from "tslint";
import {logger} from "@eventicle/eventicle-utilities";

export type whereQueryBuilder = (key: string, query: DataQuery) => string

const whereBuilders = new Map<string, whereQueryBuilder>()

export function addColumnWhere(column: string, where: whereQueryBuilder) {
  whereBuilders.set(column, where)
}

function formatLeftQuery(key: string, query: DataQuery) {
  if (Number.isFinite(query.value)) {
    return ` (content->>'${key}')::numeric `;
  } else {
    return `content->>'${key}'`;
  }
}

export function jsonColumnQueryBuilder(key: string, query: DataQuery) {

  let queryString = ""

  switch (query.op) {
    case "IN":
      queryString += ` AND ${formatLeftQuery(key, query)} = ANY($[${key}])`;
      // params.push(query.value as any)
      break;
    case "EQ":
      queryString += ` AND ${formatLeftQuery(key, query)} = $[${key}]`;
      // params.push(query.value as any)
      break;
    case "GT":
      queryString += ` AND ${formatLeftQuery(key, query)} > $[${key}]`;
      // params.push(query.value as any)
      break;
    case "GTE":
      queryString += ` AND ${formatLeftQuery(key, query)} >= $[${key}]`;
      break;
    case "LT":
      queryString += ` AND ${formatLeftQuery(key, query)} < $[${key}]`;
      break;
    case "LTE":
      queryString += ` AND ${formatLeftQuery(key, query)} <= $[${key}]`;
      break;
    case "BETWEEN":
      queryString += ` AND ${formatLeftQuery(key, query)} between $[${key}_0] and $[${key}_1]`;
      break;
    case "OBJECT":
      queryString = `${queryString} AND content @> $[${key}]`;
      break;
    case "LIKE":
      const {value} = query as any
      const {path = []} = value
      if(path.length > 0) {
        const last = path.pop()
        const k = `content ${path.length > 0?' -> ':''}${path.join("' -> '")} ->> '${last}'`
        queryString = `${queryString} AND ${k} ilike $[${key}]`
      }
      break;
  }
  return queryString;
}

export function buildQueryObject(query: { [p: string]: string | number | DataQuery }, workspaceId: string, type: string): any {

  let queryObject = { xxx_workspaceId: workspaceId, xxx_type: type } as any
  Object.keys(query).forEach((value) => {

    if (!query[value]) {
      logger.warn("Query contains undefined value", { query, keyname: value })
      return
    }

    let dataQuery: DataQuery = null

    if(["string", "number"].includes(typeof query[value])) {
      dataQuery = {
        value: query[value] as string,
        op: "EQ"
      }
      // @ts-ignore
    } else if(query[value].op == "LIKE") {
      dataQuery = {
        // @ts-ignore
        value: `%${query[value].value.like}%` || "",
        op: "LIKE"
      }
    } else {
      dataQuery = query[value] as DataQuery
    }

    if (dataQuery === null) {
      dataQuery = {
        value: null,
        op: "EQ"
      }
    }

    queryObject[value] = dataQuery.value
  });

  return queryObject
}

export function buildWhere(query: { [p: string]: string | number | DataQuery }) {
  let queryString = ""
  Object.keys(query).forEach((value) => {

    let dataQuery: DataQuery = null

    if(["string", "number"].includes(typeof query[value])) {
      dataQuery = {
        value: query[value] as string,
        op: "EQ"
      }
    } else {
      dataQuery = query[value] as DataQuery
    }

    if (!dataQuery) {
      dataQuery = {
        value: null,
        op: "EQ"
      }
    }

    let builder = jsonColumnQueryBuilder
    if (whereBuilders.has(value)) {
      builder = whereBuilders.get(value)
    }

    queryString += builder(value, dataQuery);

  });

  return queryString;
}

export function baseQuery(type, tableName, workspaced: boolean) {
  if (workspaced) {
    return `select * from ${tableName} where workspace_id = $[xxx_workspaceId] and type = $[xxx_type]`;
  }
  return `select * from ${tableName} where type = $[xxx_type]`;
}
