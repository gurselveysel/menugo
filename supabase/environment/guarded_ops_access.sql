-- ALREADY APPLIED. Environment setup; not run in PGlite fixtures.
ALTER ROLE authenticator SET pgrst.db_schemas='public,graphql_public,ops';
NOTIFY pgrst,'reload config';
NOTIFY pgrst,'reload schema';
