// Catalog-only snapshot: never reads customer rows or credentials.
export async function schemaSnapshot(tx) {
  await tx`set local search_path to pg_catalog`;
  const queries = {
    relations: tx`select c.relname as name,c.relkind as kind,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='invento' and c.relkind in ('r','v','m','p','S') order by 1`,
    columns: tx`select c.relname as relation,a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as required,pg_get_expr(d.adbin,d.adrelid) as default_value,a.attidentity as identity,a.attgenerated as generated from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='invento' and c.relkind in ('r','v','m','p') and a.attnum>0 and not a.attisdropped order by 1,2`,
    // PostgreSQL 18 also exposes NOT NULL as constraints; columns.required checks
    // the same invariant across both PostgreSQL 17 and 18.
    constraints: tx`select c.relname as relation,k.conname as name,pg_get_constraintdef(k.oid) as definition,k.convalidated as validated from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='invento' and k.contype<>'n' order by 1,2`,
    indexes: tx`select c.relname as relation,i.relname as name,pg_get_indexdef(i.oid) as definition,x.indisvalid as valid from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='invento' order by 1,2`,
    triggers: tx`select c.relname as relation,t.tgname as name,pg_get_triggerdef(t.oid) as definition,t.tgenabled as enabled from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='invento' and not t.tgisinternal order by 1,2`,
    functions: tx`select p.proname as name,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='invento' order by 1,2`,
    views: tx`select c.relname as name,pg_get_viewdef(c.oid) as definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='invento' and c.relkind in ('v','m') order by 1`,
    policies: tx`select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='invento' order by tablename,policyname`,
  };
  const result = {};
  for (const [name, query] of Object.entries(queries)) result[name] = [...await query];
  // SQL-editor pastes may preserve Windows line endings in function bodies.
  for (const fn of result.functions) fn.definition = fn.definition.replace(/\r\n/g, '\n');
  return result;
}
