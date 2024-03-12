//! Rust support for KCL (aka the KittyCAD Language).
//!
//! KCL is written in Rust. This crate contains the compiler tooling (e.g. parser, lexer, code generation),
//! the standard library implementation, a LSP implementation, generator for the docs, and more.
#![recursion_limit = "1024"]

pub mod ast;
pub mod docs;
pub mod engine;
pub mod errors;
pub mod executor;
pub mod fs;
pub mod lsp;
pub mod parser;
pub mod std;
pub mod token;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
