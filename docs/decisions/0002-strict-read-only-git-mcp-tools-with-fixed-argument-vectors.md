# Strict read-only git MCP tools with fixed argument vectors

Status: accepted (generated, pending human review)

## Context

Coding agents need repository history but shells invite injection and unbounded output. Existing git MCP servers often expose write operations.

## Decision

Expose exactly three read-only tools (log, diff, blame) that validate refs and paths against strict rules, use --end-of-options/--, disable external drivers/pagers/prompts and bound time/output.

## Consequences

Safe by construction; no write access, no working-tree status, single repository. Output truncation discards incomplete records. Argument validation is centralized and tested.
