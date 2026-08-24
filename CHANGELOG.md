# Changelog

## [0.3.1](https://github.com/supabase/middleware/compare/middleware-v0.3.0...middleware-v0.3.1) (2026-08-24)


### Bug Fixes

* export isContext so hosts can guard seedContext ([#28](https://github.com/supabase/middleware/issues/28)) ([7e1f795](https://github.com/supabase/middleware/commit/7e1f7952fb89485353461b56d791a8fc1cd117c5))

## [0.3.0](https://github.com/supabase/middleware/compare/middleware-v0.2.0...middleware-v0.3.0) (2026-08-11)


### ⚠ BREAKING CHANGES

* NoConflict takes a required third type parameter, the handler type to resolve to when the key is free. `NoConflict<Key, Base>` now fails on arity; pass the handler type third and leave the `Base` constraint as `In & BaseContext`. Constraint-position siting is no longer supported.

### Bug Fixes

* `satisfies FetchHandler` fails typecheck in consumer handlers if nesting depth &gt;2 ([#21](https://github.com/supabase/middleware/issues/21)) ([9a44e9d](https://github.com/supabase/middleware/commit/9a44e9db7065100a2c8cdc0da82ef7a2823fca8b))

## [0.2.0](https://github.com/supabase/middleware/compare/middleware-v0.1.0...middleware-v0.2.0) (2026-08-06)


### Features

* add composable, type-safe middleware for web fetch handlers ([1ad6737](https://github.com/supabase/middleware/commit/1ad6737dfd0e60c39ed9357eddc4ce5a6546f5dd))
* add flat pipeline syntax — mw(config) returns an Entry ([3915593](https://github.com/supabase/middleware/commit/3915593391d1933d6ff2fcb914b0816f9b03919f))
* **auth:** ship withAuth JWT middleware contributing ctx.jwtClaims (R8) ([e3f591b](https://github.com/supabase/middleware/commit/e3f591bcd4c7cf357e0f8ed4c907762bb5686dde))
* **core:** add .as(key) re-key for intentional multi-instance (R4) ([0c6eb31](https://github.com/supabase/middleware/commit/0c6eb31409a0d747d41d748f2bc7f392c4842607))
* **core:** add opt-in withCatch error boundary (R3) ([1a14311](https://github.com/supabase/middleware/commit/1a14311c845770fc0e859403337de6407fef193d))
* **core:** add read-once-cache ctx.body to fix one-shot body consumption (R2) ([8376021](https://github.com/supabase/middleware/commit/8376021151575bd42059a92d3ec8e7c1a62db459))
* **core:** add withResponse universal response seam ([#1](https://github.com/supabase/middleware/issues/1)); public-API test ([824433d](https://github.com/supabase/middleware/commit/824433d0dcb42c7ad2f719d47b585a78daaef27e))
* flat pipeline syntax — mw(config) returns an Entry directly ([537f5ed](https://github.com/supabase/middleware/commit/537f5ed8eb11a050a485ed411fe999be61d9bf85))
* flat pipeline syntax — mw(config) returns an Entry directly ([132daf9](https://github.com/supabase/middleware/commit/132daf961203eb2e599d0bd2e9d3e12a4db7760e))
* **implement:** complete `web-middleware` framework ready for use ([b1a66c3](https://github.com/supabase/middleware/commit/b1a66c3666ac85cd8d3fafe6b612896e194a5650))
* response seam via generator middleware + withCors ([eb66d68](https://github.com/supabase/middleware/commit/eb66d688812cae064cd9b0eee2ec29d0185e63af))
* **yield-contribution:** middleware can `yield` a `Contribution` and receive a `Response` ([cf6e397](https://github.com/supabase/middleware/commit/cf6e397c81de7c4d69e4ed0dd1833cd8396adc60))


### Bug Fixes

* **core:** make buffered request faithful — cache formData(), share body on clone() (R6/[#6](https://github.com/supabase/middleware/issues/6)) ([debdade](https://github.com/supabase/middleware/commit/debdadef163d4846da501b19acb85c6476729843))
* **core:** unit-test arg-2 env per runtime; throw not-implemented on arg 3 ([b3f8fd9](https://github.com/supabase/middleware/commit/b3f8fd95ecc41c0102e314e3d2ef21ded7ca5d8d))
* **core:** warn (not throw) on unhonored 3rd fetch arg; add NEEDS_WORK ([0f58871](https://github.com/supabase/middleware/commit/0f58871e959170c45bba0ab362567b2ff3fc3ba2))
* **cors:** pass through non-reconstructable responses in the response phase ([#13](https://github.com/supabase/middleware/issues/13)) ([fdebc9b](https://github.com/supabase/middleware/commit/fdebc9b386a50c396edaa85363edbadf8b86ced9))
