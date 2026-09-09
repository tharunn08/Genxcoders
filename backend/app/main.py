import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from .core.config import ensure_storage_buckets, get_settings
from .core.db import describe_db_error
from .routers import (auth, catalog, exports, imports, intelligence,
                      site_admin, warehouse, workflow)

settings = get_settings()
log = logging.getLogger("retailmind")

app = FastAPI(
    title=settings.app_name,
    description="Demand forecasting, inventory intelligence and smart replenishment.",
    version="1.1.0",
)

# Explicit origin list rather than a wildcard: allow_credentials=True and
# allow_origins=["*"] are mutually incompatible in the CORS spec, and browsers
# reject the combination silently.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "Origin",
                   "X-Requested-With"],
    expose_headers=["Content-Disposition"],
    max_age=600,
)


# The dashboard payload is a few hundred KB of JSON on a real catalog. Gzip
# turns that into tens of KB, which matters over a slow link and costs almost
# nothing to produce.
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def timing(request: Request, call_next):
    """Log slow requests and expose the duration to the browser.

    The performance problems in this app were invisible from the frontend: a
    request that took ninety seconds and one that never connected looked the
    same. A server-timing header and a log line make the difference obvious.
    """
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Response-Time-Ms"] = f"{elapsed_ms:.0f}"
    if elapsed_ms > 3000:
        log.warning("Slow: %s %s took %.0f ms",
                    request.method, request.url.path, elapsed_ms)
    return response


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    """Translate database failures instead of flattening them into one 500.

    supabase-py raises postgrest.APIError carrying a Postgres SQLSTATE. Letting
    that fall through to a generic "something went wrong" discarded the only
    piece of information that explained the failure, and a 500 on any single
    panel made the whole UI look disconnected. A unique-violation is a 409 the
    user can act on; a missing column is a 400 that says to run the migrations.
    """
    status_code, message, detail = describe_db_error(exc)

    if status_code >= 500:
        log.exception("Unhandled error on %s %s", request.method, request.url.path)
    else:
        log.warning("%s on %s %s: %s", status_code,
                    request.method, request.url.path, message)

    body = {"detail": message if status_code < 500
            else "Something went wrong on our side. Try again in a moment."}
    if settings.is_dev:
        # Surfacing the real cause locally is the difference between a two-minute
        # fix and an afternoon of guessing.
        body["error"] = f"{type(exc).__name__}: {exc}"[:500]
        if detail:
            body["db_detail"] = str(detail)[:500]
    return JSONResponse(status_code=status_code, content=body)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok", "service": settings.app_name}


@app.get("/api/health", tags=["system"])
def api_health():
    """Same check behind the /api prefix.

    The frontend's base URL already ends in /api, so this is the path it can
    actually reach — useful for confirming the prefix is wired correctly.
    """
    return {"status": "ok", "service": settings.app_name}


@app.get("/api/debug/connectivity", tags=["system"])
def connectivity(request: Request):
    """Diagnostics for the browser-can't-reach-backend class of problem.

    Reports the Origin the browser actually sent and whether CORS will accept
    it, so a misconfigured origin is visible instead of being inferred from a
    generic network failure.
    """
    origin = request.headers.get("origin")
    return {
        "reached_backend": True,
        "request_origin": origin,
        "origin_allowed": origin is None or origin.rstrip("/") in settings.cors_list,
        "allowed_origins": settings.cors_list,
        "captcha_enabled": settings.captcha_enabled,
        "environment": settings.environment,
        "hint": ("If you can read this in the browser console, the network path and "
                 "CORS are both fine."),
    }


for router in (auth.router, catalog.router, imports.router,
               intelligence.router, workflow.router,
               site_admin.router, exports.router, warehouse.router):
    app.include_router(router, prefix="/api")


@app.on_event("startup")
def announce():
    # A missing storage bucket used to surface mid-request as "The bucket has
    # not been created". Create them up front so the first upload just works.
    ensure_storage_buckets()
    log.info("%s ready. CORS origins: %s", settings.app_name, ", ".join(settings.cors_list))
