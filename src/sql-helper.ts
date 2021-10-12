import {DataQuery} from "@eventicle/eventicle-utilities/dist/datastore";

export type whereQueryBuilder = (key: string, query: DataQuery) => string

const whereBuilders = new Map<string, whereQueryBuilder>()

export function addColumnWhere(column: string, where: whereQueryBuilder) {
  whereBuilders.set(column, where)
}

export function jsonColumnQueryBuilder(key: string, query: DataQuery) {
  let queryString = ""

  switch (query.op) {
    case "IN":
      queryString += ` AND content->>'${key}' = ANY($[${key}])`;
      // params.push(query.value as any)
      break;
    case "EQ":
      queryString += ` AND content->>'${key}'= $[${key}]`;
      // params.push(query.value as any)
      break;
    case "GT":
      queryString += ` AND content->>'${key}' > $[${key}]`;
      // params.push(query.value as any)
      break;
    case "GTE":
      queryString += ` AND content->>'${key}' >= $[${key}]`;
      // params.push(query.value as any)
      break;
    case "LT":
      queryString += ` AND content->>'${key}' < $[${key}]`;
      // params.push(query.value as any)
      break;
    case "LTE":
      queryString += ` AND content->>'${key}' <= $[${key}]`;
      // params.push(query.value as any)
      break;
    case "BETWEEN":
      queryString += ` AND content->>'${key}' between $[${key}_0] and $[${key}_1]`;
      // params.push((query.value as any)[0])
      // params.push((query.value as any)[1])
      break;
    case "OBJECT":
      queryString = `${queryString} AND content @> $[${key}]`;
      // params.push(JSON.stringify(query.value) as any)
      break;
  }
  return queryString;
}

export function buildQueryObject(query: { [p: string]: string | number | DataQuery }, workspaceId: string, type: string): any {

  let queryObject = { xxx_workspaceId: workspaceId, xxx_type: type } as any

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

    if (dataQuery == null) {
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

    if (dataQuery == null) {
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
