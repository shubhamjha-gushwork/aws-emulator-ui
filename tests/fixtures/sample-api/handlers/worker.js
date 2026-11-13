exports.handler = async (event) => ({ ok: true, records: event.Records?.length ?? 0 });
