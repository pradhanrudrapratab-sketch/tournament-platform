// client = pool/db or a transaction client; never put secrets or room credentials in meta.
async function audit(client, { actor = null, action, type = null, id = null, reason = null, meta = null }) {
  await client.query(
    'INSERT INTO audit_logs(actor_user_id, action, resource_type, resource_id, reason, metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [actor, action, type, id == null ? null : String(id), reason, meta ? JSON.stringify(meta) : null]
  );
}
module.exports = audit;
