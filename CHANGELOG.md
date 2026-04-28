# Changelog

All notable changes to `@studio-b-ai/clients` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0](https://github.com/studio-b-ai/clients/compare/v1.0.0...v1.1.0) (2026-04-28)


### Features

* @studio-b-ai/outcome-envelope v1.0.0 ([93bc83f](https://github.com/studio-b-ai/clients/commit/93bc83f27e2ec50234d230192a81d6bc19da41d0))
* **acumatica:** per-tenant lockout key on AcumaticaClient ([#7](https://github.com/studio-b-ai/clients/issues/7)) ([2eb0c7d](https://github.com/studio-b-ai/clients/commit/2eb0c7d20750d638faed2ea5a99e39e1d60622c2))

## 1.0.0 (2026-04-19)


### Features

* **acumatica:** scope SessionPool keys by (baseUrl, account, company) ([#1](https://github.com/studio-b-ai/clients/issues/1)) ([e1f947c](https://github.com/studio-b-ai/clients/commit/e1f947c29c03d307ea5ac06661990e62428dd27e))
* add Acumatica recipes (gatedQuery, getCustomerFull, batchGetByFilter, setEntityAttribute) ([cbb4c50](https://github.com/studio-b-ai/clients/commit/cbb4c509dd77044783da1bfb15faae04fafdd7a3))
* add AES-256-GCM token encryption for Slack installations ([599e4c6](https://github.com/studio-b-ai/clients/commit/599e4c6334245dbf464fc8d164b30de230ce8d5f))
* add getOData method for GI queries — uses session cookie at /odata/ path ([5507113](https://github.com/studio-b-ai/clients/commit/5507113ebd0e5f9936c03388dee496c1d8c0d9d2))
* add HubSpot recipes (upsertByProperty, associateObjects, pipelineStageMap) ([843c24e](https://github.com/studio-b-ai/clients/commit/843c24eebbecfd73664534cd9d46573851ebf5be))
* add recipes entry points to @studio-b-ai/clients ([fcf2de7](https://github.com/studio-b-ai/clients/commit/fcf2de7a859c8fb1e585a5c93b2b9fb3caa78ec5))
* add SlackClient to @studio-b-ai/clients ([fdaf4ae](https://github.com/studio-b-ai/clients/commit/fdaf4ae73dcdca256a68f08b94a11996af3a9146))
* add Zoom recipes (provisionPhone, deprovisionPhone) ([f65b2c6](https://github.com/studio-b-ai/clients/commit/f65b2c66e254416c58ee5237757c65fda148ac3d))
* **clients,mcp:** createProject returns environments + bulk var upsert ([#24](https://github.com/studio-b-ai/clients/issues/24)) ([aebaa31](https://github.com/studio-b-ai/clients/commit/aebaa31e9e32ce0669876b1addf555f7883496a6))
* **clients,mcp:** Railway project-level tools for Bolt tenant deploys ([#22](https://github.com/studio-b-ai/clients/issues/22)) ([8e57597](https://github.com/studio-b-ai/clients/commit/8e5759729ac64c3b004de9f9acb6d90a7c7bb4ee))
* **clients,mcp:** railway_attach_custom_domain for Bolt tenant deploys ([#23](https://github.com/studio-b-ai/clients/issues/23)) ([8928269](https://github.com/studio-b-ai/clients/commit/89282698725b18862b2cdc84fb17a45a42b221fb))
* **clients:** add Acumatica lockout circuit breaker ([8a5be70](https://github.com/studio-b-ai/clients/commit/8a5be70545401eb1c8b3438347e0cebb420da9a1))
* **clients:** add AcumaticaGatewayClient for gateway REST proxy ([9b8fd17](https://github.com/studio-b-ai/clients/commit/9b8fd1769054483f9435c8fe0807a1692862ed60))
* **clients:** onEvent callback for pool observability ([c71a6f2](https://github.com/studio-b-ai/clients/commit/c71a6f2948dba9b14232f3ba8ef2fa4fe94d2d4c))
* **clients:** per-account session pool ([2b4c6a2](https://github.com/studio-b-ai/clients/commit/2b4c6a22a4020229b2a4b85a280ef139da99dd6d))
* **clients:** Redis integration tests + CI service container ([c6d8049](https://github.com/studio-b-ai/clients/commit/c6d8049e8d5d2d2d124e835f573ac012cf314dbc))
* **clients:** scaffold SessionPool with types, Lua scripts, constructor ([ca2ef4c](https://github.com/studio-b-ai/clients/commit/ca2ef4c3524e936b22aad814228ee89725c8da7b))
* **clients:** SessionPool checkout timeout and backpressure ([1d6439c](https://github.com/studio-b-ai/clients/commit/1d6439ced7bd7ad522375b83fceee3c955b96a47))
* **clients:** SessionPool checkout/checkin with Redis cookie reuse ([66914b8](https://github.com/studio-b-ai/clients/commit/66914b881c97fe8f2d92d3d029284036625e0177))
* **clients:** SessionPool keepalive timer for idle session ping ([1c0b38d](https://github.com/studio-b-ai/clients/commit/1c0b38d50137b6fd960edbcf60dfa685427b0f10))
* **clients:** SessionPool status reporting ([0f77f02](https://github.com/studio-b-ai/clients/commit/0f77f02ad1fbe9357d3c386036af4d59faf1a2ab))
* **clients:** SessionPool withSession, eviction, stale reclamation ([6f0e8f9](https://github.com/studio-b-ai/clients/commit/6f0e8f96ec720e10258d2d245b9dc60adf290d41))
* **linkedin:** LinkedIn API client, OAuth auth, config schema, and tests ([6a88a60](https://github.com/studio-b-ai/clients/commit/6a88a60fcbc05ea00a784b17a4a5f79c91b585c6))
* lockout guard v2 — prevention + login budget + password rotation CLI ([3959f8d](https://github.com/studio-b-ai/clients/commit/3959f8dbca820972c7ba6b0447afc9f28cd1e841))
* multi-tenant + bolt selection for allocate-lot ([32947c3](https://github.com/studio-b-ai/clients/commit/32947c392ad5f01a640050d474dd83ca15ff2bd2))
* Phase 1 scaffold — Turborepo monorepo with shared clients, CLI, and placeholders ([82e4f57](https://github.com/studio-b-ai/clients/commit/82e4f57883363653a4edbeb5a879493709a9b3d2))
* Phase 2 — Hono REST API with OpenAPI auto-generation ([fccaa3b](https://github.com/studio-b-ai/clients/commit/fccaa3bfa809931287c1d92c4136f56d2c4c331c))
* Phase 4 — add GoDaddy, Zoom, Microsoft, HubSpot to all interfaces ([d128d6b](https://github.com/studio-b-ai/clients/commit/d128d6b5a0e3f5a05c35b2c92815717daf245156))
* Phase 4 — add GoDaddy, Zoom, Microsoft, HubSpot to all interfaces ([d669eb4](https://github.com/studio-b-ai/clients/commit/d669eb492c925903acf9e11f7a1e309c9eb7a797))
* **shared:** AES-256-CBC token encryption utility with tests ([be37ac7](https://github.com/studio-b-ai/clients/commit/be37ac71b89b31cbc1967f3f2f0573700a1a4040))


### Bug Fixes

* add public login() method to AcumaticaClient and fix callCount reference ([9194db4](https://github.com/studio-b-ai/clients/commit/9194db4b6084f903f73c6078a8d8298cb7d39672))
* address code review — named types, unwrapped returns, shared errors ([e4fb47a](https://github.com/studio-b-ai/clients/commit/e4fb47a2d136d8b10ebeedd0ad39d0aa4b2e2225))
* auto-reset perCycle budget counter + add reset endpoint ([#18](https://github.com/studio-b-ai/clients/issues/18)) ([5fa2a30](https://github.com/studio-b-ai/clients/commit/5fa2a308eb01645e68c8e75e6442e25fc26a840b))
* **clients:** add linkedin/index to tsup entry points — was missing from build ([ffedbc2](https://github.com/studio-b-ai/clients/commit/ffedbc2590e553b0228bb4d33b78288170674b3e))
* **clients:** bump version to 0.1.4 to unblock CI publish ([f6d4108](https://github.com/studio-b-ai/clients/commit/f6d4108a893405ea06dcafb18d16506090f01a14)), closes [#4](https://github.com/studio-b-ai/clients/issues/4)
* **clients:** raise LOGIN_BUDGET_MAX to 5, export SessionPool ([218226f](https://github.com/studio-b-ai/clients/commit/218226f531ab79d9fc248a56b1716f9a11ff2300))
* **clients:** resolve merge conflict in ensureLoggedIn — keep both circuit breaker + Redis lockout guard ([ee32933](https://github.com/studio-b-ai/clients/commit/ee329336de2997c2e1db2c6fde2c042f361ea65a))
* **clients:** soap-client allocateLot tests expect post-split two-submit flow ([#37](https://github.com/studio-b-ai/clients/issues/37)) ([b083596](https://github.com/studio-b-ai/clients/commit/b083596a78dd20653800a63cc95f684b830fa804))
* Decode base64-corrupted clients/package.json ([e06f92e](https://github.com/studio-b-ai/clients/commit/e06f92e4f2e23391434476ef609f03556a76658e))
* **hubspot:** add buildSearchBody + typed HubSpotSearchOpts — faithfully passes filterGroups to CRM Search API with value string-coercion and debug logging ([bbd96ea](https://github.com/studio-b-ai/clients/commit/bbd96ea7ac476decaef41fa3e136c55893e693df))
* **hubspot:** export new typed interfaces from HubSpotClient (HubSpotSearchOpts, HubSpotFilter, HubSpotFilterGroup) ([325ad02](https://github.com/studio-b-ai/clients/commit/325ad02ce1fd933144f0a791b1db1bf2c54293ae))
* include dist/ in published @studio-b-ai/clients package ([db75949](https://github.com/studio-b-ai/clients/commit/db75949cb6778efd328f7a851b128362a4fa2835))
* include tenant/company in OData GI path — required for multi-company Acumatica ([234522e](https://github.com/studio-b-ai/clients/commit/234522e3471799d91b800436f8794c99f2247228))
* increase SOAP timeout to 60s (Key navigation can be slow) ([abaaa9e](https://github.com/studio-b-ai/clients/commit/abaaa9e73245995faeae1e201b4c6bba2d1e73f6))
* **linkedin:** align schema and client with spec — discrete columns, correct enums, missing methods ([15f1ae4](https://github.com/studio-b-ai/clients/commit/15f1ae444a816d56bcbc4c073396e5a30a3c6f83))
* omit xsi:type for field commands, only use Action for Save ([80c7a95](https://github.com/studio-b-ai/clients/commit/80c7a95504ce0a7e44be7bf33fcceae4b6c3fbdc))
* **pkg:** add repository, homepage, bugs, license fields ([f0c2367](https://github.com/studio-b-ai/clients/commit/f0c236720cdbb32aa21bff0e7c05aba11186d881))
* **publish-clients:** drop provenance ([#46](https://github.com/studio-b-ai/clients/issues/46)) ([b66f793](https://github.com/studio-b-ai/clients/commit/b66f793c11b90f54bd955cf3290b826762ade112))
* **railway:** 3 bugs from bolt-throwaway rehearsal (2026-04-17) ([#28](https://github.com/studio-b-ai/clients/issues/28)) ([45afe1a](https://github.com/studio-b-ai/clients/commit/45afe1ab3f9467bfca5a417c843a50a54bbc958d))
* **railway:** listProjects uses top-level projects query (API-token compat) ([#26](https://github.com/studio-b-ai/clients/issues/26)) ([eba2a04](https://github.com/studio-b-ai/clients/commit/eba2a04d57f44bf6369a1a9ea77cdcd02e445499))
* **railway:** projectId override on listServices/listEnvironments/getProjectUsage ([#32](https://github.com/studio-b-ai/clients/issues/32)) ([1dc16ab](https://github.com/studio-b-ai/clients/commit/1dc16abf84ccde1e3bef72637452d4a720c9735f))
* **railway:** projectId override on variable/domain methods for tenant deploys ([#27](https://github.com/studio-b-ai/clients/issues/27)) ([80f04f4](https://github.com/studio-b-ai/clients/commit/80f04f4eb40df2408cf5ae5680c3d9cec2509578))
* remove Quantity from SOAP lot allocation commands ([bd48521](https://github.com/studio-b-ai/clients/commit/bd4852182ef8b096ff6700b1d590593fff10010e))
* shared AcumaticaClient OData must use Basic Auth, not cookies ([61e9530](https://github.com/studio-b-ai/clients/commit/61e95306e3ebea1fb26f43838faf558928253e62))
* split SOAP into two Submit calls — navigate then write ([e429c86](https://github.com/studio-b-ai/clients/commit/e429c86af604ddbc205c5bd5d379394d08a7093f))
* use correct SOAP xsi:type for commands (Value/Action, not Field) ([4e3ec61](https://github.com/studio-b-ai/clients/commit/4e3ec6181c3b91d29ffc1e2edd8aa6dc4e4b6310))
* use Key type for SOAP navigation, Value for writes, Action for Save ([43849c1](https://github.com/studio-b-ai/clients/commit/43849c1e1794187a4e4165fee5502d913744fb9f))

## [0.2.0] - 2026-04-18

### Changed
- Repository moved from the `studio-b-ai/studiob` monorepo to the standalone public `studio-b-ai/clients` repo.
- Publishes now include npm provenance attestations (sigstore-signed via GitHub Actions OIDC).

### Unchanged
- API surface identical to 0.1.5 — no import path or type changes.

---

Pre-0.2.0 release history is preserved in the `studio-b-ai/studiob` monorepo git log and in filtered form at the root of this repo's git log. It is not back-filled into this CHANGELOG.
