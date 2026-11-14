//! `notary-template-normalize IN OUT`: re-encodes a module through `wasm-encoder`'s re-encoder (and drops the linker's extra exports). The linker
//! pads relocatable operands (such as the table index of `call_indirect`) to five bytes, which is valid only with the
//! reference-types proposal; the re-encoder writes the canonical one-byte form. The module's meaning is unchanged, and
//! the output is deterministic.
use wasm_encoder::reencode::{Error, Reencode};
use wasm_encoder::ExportSection;

/// The round-trip re-encoder, except that only the two exports a `notary_v1` module may have (runtime §6, A8) are kept:
/// rustc also exports the linker's `__data_end` and `__heap_base`.
struct Normalize;
impl Reencode for Normalize {
    type Error = std::convert::Infallible;
    fn parse_export_section(&mut self, exports: &mut ExportSection, section: wasmparser::ExportSectionReader<'_>) -> Result<(), Error<Self::Error>> {
        for e in section {
            let e = e?;
            if e.name == "memory" || e.name == "run" {
                self.parse_export(exports, e);
            }
        }
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output] = args.as_slice() else { eprintln!("usage: notary-template-normalize IN OUT"); std::process::exit(2) };
    let bytes = std::fs::read(input).expect("read");
    let mut module = wasm_encoder::Module::new();
    Normalize.parse_core_module(&mut module, wasmparser::Parser::new(0), &bytes).expect("re-encode");
    std::fs::write(output, module.finish()).expect("write");
}
