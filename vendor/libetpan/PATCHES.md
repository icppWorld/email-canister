# Local changes to libetpan

libetpan casts one-argument `free` functions to callback types with a different
signature. On native targets that is harmless. WebAssembly checks the signature
of every indirect call, so the call traps with "function invocation does not
match its signature". An LTO build hides it only where the optimizer happens to
inline the callback.

- `clist.c`: `clist_foreach` calls its callback with the item only. Every caller
  here passes a one-argument callback and `NULL`, so `data` is ignored.
- `mailimf.c`: `mailimf_struct_destructor` returns `void`, like the functions it
  points to. No caller used the return value.
- `mailmime_rfc2231.c`: its two callbacks take one argument, like all the others.

To audit after updating libetpan, compile with `-Wcast-function-type`. Casts that
differ only in pointer types are safe, because WebAssembly sees `i32` for each.
