fn main() {
    let out = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("pictures.rs");
    if let Err(e) = engraver::engrave(std::path::Path::new("pictures"), &out, "crate::picture") {
        panic!("{e}");
    }
}
