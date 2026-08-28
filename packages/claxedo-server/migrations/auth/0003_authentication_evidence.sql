-- Authentication assurance is captured by the successful sign-in producer.
-- Available linked accounts are deliberately not authentication evidence.

create table "authenticationEvidence" ("sessionId" text not null primary key, "subject" text not null, "authenticatedAt" integer not null check ("authenticatedAt" > 0), "methods" text not null check ("methods" in ('["password"]', '["oauth:google"]', '["oauth:github"]')), "assurance" text not null check ("assurance" = 'single-factor'), "createdAt" integer not null check ("createdAt" > 0), foreign key ("sessionId") references "session" ("id") on delete cascade, foreign key ("subject") references "user" ("id") on delete cascade);

create trigger "authenticationEvidence_session_binding_insert" before insert on "authenticationEvidence" begin select case when not exists (select 1 from "session" where "id" = new."sessionId" and "userId" = new."subject") then raise(abort, 'authentication evidence must match its session subject') end; end;

create trigger "authenticationEvidence_no_update" before update on "authenticationEvidence" begin select raise(abort, 'authentication evidence is immutable'); end;

create trigger "authenticationEvidence_no_direct_delete" before delete on "authenticationEvidence" when exists (select 1 from "session" where "id" = old."sessionId") begin select raise(abort, 'authentication evidence can be deleted only with its session'); end;
