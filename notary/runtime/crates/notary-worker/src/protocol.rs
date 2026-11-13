//! Broker–worker framing and messages (notary_runtime.md §8).
//!
//! Each frame is a 4-byte big-endian length followed by RFC 8785 JSON, at most 16 MiB. Every message has `kind` and
//! `req_id`. Binary fields are base64url. The worker side is `serve`: it reads `load`, `run` and `terminate` from
//! one pipe and writes `loaded`, `output` and `error` to the other. It never sees keys, card data or other jobs.
use crate::{Program, RunLimits};
use notary_types::{b64u, jcs};
use serde_json::{json, Value};
use std::io::{Read, Write};

pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub fn write_frame(w: &mut impl Write, v: &Value) -> std::io::Result<()> {
    let bytes = jcs::canonical(v).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    if bytes.len() > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame exceeds 16 MiB"));
    }
    w.write_all(&(bytes.len() as u32).to_be_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

/// Reads one frame. `Ok(None)` at a clean end of stream.
pub fn read_frame(r: &mut impl Read) -> std::io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame exceeds 16 MiB"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let v: Value = serde_json::from_slice(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if v.get("kind").and_then(Value::as_str).is_none() || v.get("req_id").and_then(Value::as_str).is_none() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame is missing kind or req_id"));
    }
    Ok(Some(v))
}

fn bytes_field(v: &Value, k: &str) -> Option<Vec<u8>> {
    v.get(k).and_then(Value::as_str).and_then(|s| b64u::decode(s).ok())
}

/// The worker loop. Returns when the broker sends `terminate` or closes the pipe.
pub fn serve(input: &mut impl Read, output: &mut impl Write) -> std::io::Result<()> {
    let mut program: Option<Program> = None;
    let mut limits = RunLimits::default();
    while let Some(msg) = read_frame(input)? {
        let req_id = msg["req_id"].as_str().unwrap_or_default().to_string();
        let error = |reason: &str| json!({ "kind": "error", "req_id": req_id, "run_id": msg.get("run_id").cloned().unwrap_or(json!("")), "reason": reason });
        match msg["kind"].as_str() {
            Some("load") => {
                let Some(bytes) = bytes_field(&msg, "program") else {
                    write_frame(output, &error("trap"))?;
                    continue;
                };
                if let Some(l) = msg.get("limits") {
                    limits = RunLimits {
                        fuel: l["fuel"].as_u64().unwrap_or(crate::MAX_FUEL).min(crate::MAX_FUEL),
                        memory_pages: l["memory_pages"].as_u64().map(|p| p as u32).unwrap_or(crate::MAX_MEMORY_PAGES).min(crate::MAX_MEMORY_PAGES),
                    };
                }
                match Program::load(&bytes) {
                    Ok(p) => {
                        write_frame(output, &json!({ "kind": "loaded", "req_id": req_id, "program_hash": b64u::encode(&p.program_hash) }))?;
                        program = Some(p);
                    }
                    Err(_) => write_frame(output, &error("trap"))?,
                }
            }
            Some("run") => {
                let Some(p) = program.as_ref() else {
                    write_frame(output, &error("trap"))?;
                    continue;
                };
                let params = bytes_field(&msg, "params").unwrap_or_default();
                let inputs: Option<Vec<Vec<u8>>> = msg["inputs"]
                    .as_array()
                    .map(|a| a.iter().map(|x| x.as_str().and_then(|s| b64u::decode(s).ok())).collect::<Option<Vec<_>>>())
                    .unwrap_or(Some(vec![]));
                let Some(inputs) = inputs else {
                    write_frame(output, &error("trap"))?;
                    continue;
                };
                let run_id = msg.get("run_id").cloned().unwrap_or(json!(""));
                match p.run(&params, &inputs, limits) {
                    Ok(o) => write_frame(
                        output,
                        &json!({ "kind": "output", "req_id": req_id, "run_id": run_id, "bytes": b64u::encode(&o.bytes), "fuel_used": o.fuel_used }),
                    )?,
                    Err(e) => write_frame(output, &json!({ "kind": "error", "req_id": req_id, "run_id": run_id, "reason": e.reason() }))?,
                }
            }
            Some("terminate") => return Ok(()),
            _ => write_frame(output, &error("trap"))?,
        }
    }
    Ok(())
}
