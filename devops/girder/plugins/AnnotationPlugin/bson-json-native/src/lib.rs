//! Transcode raw BSON documents straight to the JSON the annotation plugin
//! serves: for each document, the bytes of
//! `orjson.dumps(bson.decode(doc), default=orJsonDefaults)`, where
//! `orJsonDefaults` turns an ObjectId into its hex string
//! (`server/helpers/serialization.py`).
//!
//! The plugin's Python path builds a dict per document and per coordinate
//! (~13M objects for 100K cell polygons) only to serialize them again. This
//! walks the BSON bytes once and appends JSON to a buffer instead.
//!
//! Anything the transcoder can't render exactly as that Python path would is
//! an `Error`, never different output: the caller falls back to decoding that
//! batch in Python. That covers the BSON types not handled below (datetime,
//! binary, code, ...), a document with a repeated key (pymongo keeps the
//! last value at the first key's position), an embedded document with `$ref`
//! and `$id` keys (pymongo decodes it to a DBRef, which orjson can't
//! serialize), and nesting deeper than MongoDB allows.

use std::collections::HashSet;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The input is not well-formed BSON (bad lengths, missing terminators).
    Malformed(&'static str, usize),
    /// A BSON string or key is not valid UTF-8 (pymongo raises too).
    InvalidUtf8(usize),
    /// A BSON type this transcoder does not render.
    Unsupported(u8, usize),
    /// A key repeated within one document.
    DuplicateKey(usize),
    /// An embedded document pymongo would decode to a DBRef.
    DbRef(usize),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Malformed(what, at) => write!(f, "malformed BSON at byte {at}: {what}"),
            Error::InvalidUtf8(at) => write!(f, "invalid UTF-8 at byte {at}"),
            Error::Unsupported(t, at) => {
                write!(f, "unsupported BSON type 0x{t:02x} ({}) at byte {at}", type_name(*t))
            }
            Error::DuplicateKey(at) => write!(f, "duplicate key at byte {at}"),
            Error::DbRef(at) => write!(f, "DBRef-shaped document at byte {at}"),
        }
    }
}

impl std::error::Error for Error {}

fn type_name(t: u8) -> &'static str {
    match t {
        0x05 => "binary",
        0x06 => "undefined",
        0x09 => "datetime",
        0x0B => "regex",
        0x0C => "dbpointer",
        0x0D => "javascript code",
        0x0E => "symbol",
        0x0F => "code with scope",
        0x11 => "timestamp",
        0x13 => "decimal128",
        0xFF => "minkey",
        0x7F => "maxkey",
        _ => "unknown",
    }
}

/// MongoDB's own nesting limit. orjson's (254) is higher, so a deeper document
/// (only possible from hand-built BSON) goes through Python, which reproduces
/// orjson's behavior exactly instead of this code approximating it.
const MAX_DEPTH: u32 = 100;

/// Keys in one document level checked for repeats by a linear scan; a wider
/// level switches to a hash set, so a document with thousands of keys (a
/// gene panel) stays linear.
const LINEAR_KEY_SCAN: usize = 16;

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Escape class per byte: 0 = copy, 1 = short escape, 2 = \u00XX,
/// 3 = non-ASCII (copied, but the string needs UTF-8 validation).
/// orjson escapes `"`, `\` and control characters only: not `/`, DEL, or
/// non-ASCII (U+2028/2029 included).
static ESCAPE: [u8; 256] = {
    let mut table = [0u8; 256];
    let mut i = 0x80;
    while i < 256 {
        table[i] = 3;
        i += 1;
    }
    i = 0;
    while i < 0x20 {
        table[i] = 2;
        i += 1;
    }
    table[b'\x08' as usize] = 1;
    table[b'\t' as usize] = 1;
    table[b'\n' as usize] = 1;
    table[b'\x0c' as usize] = 1;
    table[b'\r' as usize] = 1;
    table[b'"' as usize] = 1;
    table[b'\\' as usize] = 1;
    table
};

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    #[inline]
    fn take(&mut self, n: usize, what: &'static str) -> Result<&'a [u8], Error> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len());
        match end {
            Some(end) => {
                let s = &self.buf[self.pos..end];
                self.pos = end;
                Ok(s)
            }
            None => Err(Error::Malformed(what, self.pos)),
        }
    }

    #[inline]
    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1, "truncated")?[0])
    }

    #[inline]
    fn i32(&mut self) -> Result<i32, Error> {
        Ok(i32::from_le_bytes(self.take(4, "truncated int32")?.try_into().unwrap()))
    }

    #[inline]
    fn i64(&mut self) -> Result<i64, Error> {
        Ok(i64::from_le_bytes(self.take(8, "truncated int64")?.try_into().unwrap()))
    }

    #[inline]
    fn f64(&mut self) -> Result<f64, Error> {
        Ok(f64::from_le_bytes(self.take(8, "truncated double")?.try_into().unwrap()))
    }

    /// A NUL-terminated key, without the terminator.
    #[inline]
    fn cstring(&mut self) -> Result<&'a [u8], Error> {
        let rest = &self.buf[self.pos..];
        match rest.iter().position(|&b| b == 0) {
            Some(n) => {
                let s = &rest[..n];
                self.pos += n + 1;
                Ok(s)
            }
            None => Err(Error::Malformed("unterminated key", self.pos)),
        }
    }

    /// A length-prefixed BSON string, without the trailing NUL.
    #[inline]
    fn string(&mut self) -> Result<&'a [u8], Error> {
        let at = self.pos;
        let len = self.i32()?;
        if len < 1 {
            return Err(Error::Malformed("bad string length", at));
        }
        let s = self.take(len as usize, "truncated string")?;
        if s[s.len() - 1] != 0 {
            return Err(Error::Malformed("string missing NUL", at));
        }
        Ok(&s[..s.len() - 1])
    }
}

#[inline]
fn write_str(out: &mut Vec<u8>, s: &[u8], at: usize) -> Result<(), Error> {
    // Fast path: plain ASCII with nothing to escape (keys, tags, shapes).
    if s.iter().all(|&b| ESCAPE[b as usize] == 0) {
        out.reserve(s.len() + 2);
        out.push(b'"');
        out.extend_from_slice(s);
        out.push(b'"');
        return Ok(());
    }
    write_str_slow(out, s, at)
}

#[cold]
fn write_str_slow(out: &mut Vec<u8>, s: &[u8], at: usize) -> Result<(), Error> {
    if std::str::from_utf8(s).is_err() {
        return Err(Error::InvalidUtf8(at));
    }
    out.push(b'"');
    let mut start = 0;
    for (i, &b) in s.iter().enumerate() {
        let class = ESCAPE[b as usize];
        if class == 0 || class == 3 {
            continue;
        }
        out.extend_from_slice(&s[start..i]);
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\x08' => out.extend_from_slice(b"\\b"),
            b'\x0c' => out.extend_from_slice(b"\\f"),
            _ => out.extend_from_slice(&[
                b'\\', b'u', b'0', b'0', HEX[(b >> 4) as usize], HEX[(b & 15) as usize],
            ]),
        }
        start = i + 1;
    }
    out.extend_from_slice(&s[start..]);
    out.push(b'"');
    Ok(())
}

/// orjson's float format is ryu's shortest round-trip form, with `+` before
/// a positive exponent ("1e+16", "1e-7", "0.00001", "1000000000000000.0").
/// Non-finite values become null.
#[inline]
fn write_f64(out: &mut Vec<u8>, v: f64, fbuf: &mut ryu::Buffer) {
    if !v.is_finite() {
        out.extend_from_slice(b"null");
        return;
    }
    let s = fbuf.format_finite(v).as_bytes();
    match s.iter().position(|&b| b == b'e') {
        Some(e) if s.get(e + 1) != Some(&b'-') => {
            out.extend_from_slice(&s[..=e]);
            out.push(b'+');
            out.extend_from_slice(&s[e + 1..]);
        }
        _ => out.extend_from_slice(s),
    }
}

#[inline]
fn write_i64(out: &mut Vec<u8>, v: i64) {
    // 19 digits and a sign.
    let mut buf = [0u8; 20];
    let mut n = v.unsigned_abs();
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    if v < 0 {
        i -= 1;
        buf[i] = b'-';
    }
    out.extend_from_slice(&buf[i..]);
}

struct Writer<'o, 'i> {
    out: &'o mut Vec<u8>,
    fbuf: ryu::Buffer,
    /// Keys of the documents being written, innermost last; each level
    /// checks its own keys for repeats (up to LINEAR_KEY_SCAN of them).
    keys: Vec<&'i [u8]>,
}

impl<'i> Writer<'_, 'i> {
    /// Transcode one embedded document or array starting at `r.pos` (its
    /// int32 length). `array` drops the keys and writes `[...]`.
    fn document(&mut self, r: &mut Reader<'i>, array: bool, depth: u32) -> Result<(), Error> {
        if depth > MAX_DEPTH {
            return Err(Error::Malformed("nesting too deep", r.pos));
        }
        let at = r.pos;
        let len = r.i32()?;
        if len < 5 {
            return Err(Error::Malformed("bad document length", at));
        }
        let end = at + len as usize;
        if end > r.buf.len() {
            return Err(Error::Malformed("document overruns buffer", at));
        }
        let keys_base = self.keys.len();
        // Replaces the linear scan once this level passes LINEAR_KEY_SCAN keys.
        let mut wide_keys: Option<HashSet<&'i [u8]>> = None;
        let (mut has_ref, mut has_id) = (false, false);
        self.out.push(if array { b'[' } else { b'{' });
        let mut first = true;
        loop {
            let tpos = r.pos;
            let t = r.u8()?;
            if t == 0 {
                break;
            }
            let kpos = r.pos;
            let key = r.cstring()?;
            if !first {
                self.out.push(b',');
            }
            first = false;
            if !array {
                // Most documents have a handful of keys per level, where a
                // linear scan beats hashing; a wide one switches to a set.
                let repeated = if let Some(set) = wide_keys.as_mut() {
                    !set.insert(key)
                } else if self.keys[keys_base..].contains(&key) {
                    true
                } else if self.keys.len() - keys_base < LINEAR_KEY_SCAN {
                    self.keys.push(key);
                    false
                } else {
                    let mut set: HashSet<&'i [u8]> =
                        self.keys[keys_base..].iter().copied().collect();
                    set.insert(key);
                    wide_keys = Some(set);
                    false
                };
                if repeated {
                    return Err(Error::DuplicateKey(kpos));
                }
                has_ref |= key == b"$ref";
                has_id |= key == b"$id";
                write_str(self.out, key, kpos)?;
                self.out.push(b':');
            }
            self.value(r, t, tpos, depth)?;
        }
        if r.pos != end {
            return Err(Error::Malformed("document length mismatch", at));
        }
        // pymongo turns an embedded {"$ref": <str>, "$id": ...} into a DBRef
        // (the top-level document stays a dict). Refusing every embedded
        // document with both keys leaves the exact rule to pymongo.
        if has_ref && has_id && depth > 0 {
            return Err(Error::DbRef(at));
        }
        self.keys.truncate(keys_base);
        self.out.push(if array { b']' } else { b'}' });
        Ok(())
    }

    #[inline]
    fn value(&mut self, r: &mut Reader<'i>, t: u8, tpos: usize, depth: u32) -> Result<(), Error> {
        match t {
            0x01 => {
                let v = r.f64()?;
                write_f64(self.out, v, &mut self.fbuf);
            }
            0x02 => {
                let at = r.pos;
                let s = r.string()?;
                write_str(self.out, s, at)?;
            }
            0x03 => self.document(r, false, depth + 1)?,
            0x04 => self.document(r, true, depth + 1)?,
            0x07 => {
                let oid = r.take(12, "truncated ObjectId")?;
                let mut hex = [b'"'; 26];
                for (i, &b) in oid.iter().enumerate() {
                    hex[1 + 2 * i] = HEX[(b >> 4) as usize];
                    hex[2 + 2 * i] = HEX[(b & 15) as usize];
                }
                self.out.extend_from_slice(&hex);
            }
            0x08 => match r.u8()? {
                0 => self.out.extend_from_slice(b"false"),
                1 => self.out.extend_from_slice(b"true"),
                _ => return Err(Error::Malformed("bad boolean", tpos)),
            },
            0x0A => self.out.extend_from_slice(b"null"),
            0x10 => write_i64(self.out, r.i32()? as i64),
            0x12 => write_i64(self.out, r.i64()?),
            other => return Err(Error::Unsupported(other, tpos)),
        }
        Ok(())
    }
}

/// Transcode concatenated BSON documents (one `find_raw_batches` batch) to
/// their JSON renderings joined by `,`, appended to `out`. Returns the
/// number of documents. On error, `out` is truncated back to its original
/// length.
pub fn transcode_docs(input: &[u8], out: &mut Vec<u8>) -> Result<usize, Error> {
    let start_len = out.len();
    // Float-heavy annotation JSON is ~1.45x its BSON size.
    out.reserve(input.len() + input.len() / 2);
    let mut w = Writer { out, fbuf: ryu::Buffer::new(), keys: Vec::new() };
    let mut r = Reader { buf: input, pos: 0 };
    let mut count = 0;
    while r.pos < input.len() {
        if count > 0 {
            w.out.push(b',');
        }
        if let Err(e) = w.document(&mut r, false, 0) {
            w.out.truncate(start_len);
            return Err(e);
        }
        count += 1;
    }
    Ok(count)
}

#[cfg(feature = "python")]
mod python {
    use pyo3::exceptions::PyValueError;
    use pyo3::prelude::*;
    use pyo3::types::PyBytes;

    /// transcode(batch: bytes) -> bytes
    ///
    /// The JSON of each BSON document in `batch` (concatenated documents,
    /// as `find_raw_batches` yields them), joined by ",". Raises ValueError
    /// for input it can't render exactly as orjson would; the caller then
    /// decodes that batch in Python. Releases the GIL while it works.
    #[pyfunction]
    fn transcode<'py>(py: Python<'py>, batch: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
        let out = py
            .detach(|| {
                let mut out = Vec::new();
                super::transcode_docs(batch, &mut out).map(|_| out)
            })
            .map_err(|e| PyValueError::new_err(e.to_string()))?;
        Ok(PyBytes::new(py, &out))
    }

    #[pymodule]
    fn bson_json_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
        m.add_function(wrap_pyfunction!(transcode, m)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(v: f64) -> String {
        let mut out = Vec::new();
        write_f64(&mut out, v, &mut ryu::Buffer::new());
        String::from_utf8(out).unwrap()
    }

    /// A minimal BSON document builder for the tests.
    fn doc(elements: &[(u8, &str, Vec<u8>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (t, key, value) in elements {
            body.push(*t);
            body.extend_from_slice(key.as_bytes());
            body.push(0);
            body.extend_from_slice(value);
        }
        body.push(0);
        let mut d = ((body.len() + 4) as i32).to_le_bytes().to_vec();
        d.extend(body);
        d
    }

    fn bstr(s: &str) -> Vec<u8> {
        let mut v = ((s.len() + 1) as i32).to_le_bytes().to_vec();
        v.extend_from_slice(s.as_bytes());
        v.push(0);
        v
    }

    fn json(input: &[u8]) -> Result<String, Error> {
        let mut out = Vec::new();
        transcode_docs(input, &mut out).map(|_| String::from_utf8(out).unwrap())
    }

    #[test]
    fn float_format_matches_orjson() {
        assert_eq!(f(1.0), "1.0");
        assert_eq!(f(-0.0), "-0.0");
        assert_eq!(f(0.1), "0.1");
        assert_eq!(f(1e16), "1e+16");
        assert_eq!(f(1e15), "1000000000000000.0");
        assert_eq!(f(1.2345678901234568e17), "1.2345678901234568e+17");
        assert_eq!(f(1e-5), "0.00001");
        assert_eq!(f(1e-6), "1e-6");
        assert_eq!(f(5e-324), "5e-324");
        assert_eq!(f(f64::NAN), "null");
        assert_eq!(f(f64::INFINITY), "null");
        assert_eq!(f(f64::NEG_INFINITY), "null");
    }

    #[test]
    fn ints() {
        let mut out = Vec::new();
        for v in [i64::MIN, i64::MAX, 0, -1, 42] {
            write_i64(&mut out, v);
            out.push(b' ');
        }
        assert_eq!(out, b"-9223372036854775808 9223372036854775807 0 -1 42 ");
    }

    #[test]
    fn document_shapes() {
        let coords = doc(&[
            (0x03, "0", doc(&[(0x01, "x", 1.5f64.to_le_bytes().to_vec()),
                              (0x01, "y", 2.0f64.to_le_bytes().to_vec())])),
        ]);
        let d = doc(&[
            (0x07, "_id", (0u8..12).collect()),
            (0x02, "shape", bstr("polygon")),
            (0x04, "tags", doc(&[(0x02, "0", bstr("a\"b\\c\n\u{1}/é"))])),
            (0x10, "channel", 7i32.to_le_bytes().to_vec()),
            (0x12, "big", (1i64 << 40).to_le_bytes().to_vec()),
            (0x08, "t", vec![1]),
            (0x0A, "n", vec![]),
            (0x04, "coordinates", coords),
            (0x03, "empty", doc(&[])),
        ]);
        let mut two = d.clone();
        two.extend(&d);
        let one = concat!(
            r#"{"_id":"000102030405060708090a0b","shape":"polygon","#,
            r#""tags":["a\"b\\c\n\u0001/é"],"channel":7,"big":1099511627776,"#,
            r#""t":true,"n":null,"coordinates":[{"x":1.5,"y":2.0}],"empty":{}}"#
        );
        assert_eq!(json(&d).unwrap(), one);
        assert_eq!(json(&two).unwrap(), format!("{one},{one}"));
        assert_eq!(json(&[]).unwrap(), "");
    }

    #[test]
    fn refuses_what_it_cannot_render_exactly() {
        let datetime = doc(&[(0x09, "when", 0i64.to_le_bytes().to_vec())]);
        assert!(matches!(json(&datetime), Err(Error::Unsupported(0x09, _))));
        let dup = doc(&[(0x10, "a", vec![1, 0, 0, 0]), (0x10, "a", vec![2, 0, 0, 0])]);
        assert!(matches!(json(&dup), Err(Error::DuplicateKey(_))));
        // The same key at different levels is fine.
        let nested = doc(&[(0x03, "a", doc(&[(0x10, "a", vec![1, 0, 0, 0])]))]);
        assert_eq!(json(&nested).unwrap(), r#"{"a":{"a":1}}"#);
        let bad_utf8 = doc(&[(0x02, "s", vec![2, 0, 0, 0, 0xff, 0])]);
        assert!(matches!(json(&bad_utf8), Err(Error::InvalidUtf8(_))));
        let dbref = doc(&[(0x02, "$ref", bstr("c")), (0x10, "$id", vec![5, 0, 0, 0])]);
        let embedded = doc(&[(0x04, "p", doc(&[(0x03, "0", dbref.clone())]))]);
        assert!(matches!(json(&embedded), Err(Error::DbRef(_))));
        // At the top level, or with only one of the keys, it stays a dict.
        assert_eq!(json(&dbref).unwrap(), r#"{"$ref":"c","$id":5}"#);
        let only_ref = doc(&[(0x03, "p", doc(&[(0x02, "$ref", bstr("c"))]))]);
        assert_eq!(json(&only_ref).unwrap(), r#"{"p":{"$ref":"c"}}"#);
    }

    #[test]
    fn wide_documents_stay_linear_and_still_refuse_repeats() {
        fn wide(keys: &[String]) -> Vec<u8> {
            let elements: Vec<(u8, &str, Vec<u8>)> =
                keys.iter().map(|k| (0x10, k.as_str(), vec![1, 0, 0, 0])).collect();
            doc(&elements)
        }
        let keys: Vec<String> = (0..20_000).map(|i| format!("6a18de9586eb3776{i:08x}")).collect();
        // Quadratic scanning took seconds here; linear takes milliseconds.
        let started = std::time::Instant::now();
        assert!(json(&wide(&keys)).is_ok());
        assert!(started.elapsed() < std::time::Duration::from_secs(1), "{:?}", started.elapsed());
        // A repeat is still found before and after the switch to hashing.
        for repeat_at in [3, LINEAR_KEY_SCAN, LINEAR_KEY_SCAN + 1, 5_000] {
            let mut with_repeat = keys[..6_000].to_vec();
            with_repeat.insert(repeat_at, keys[repeat_at / 2].clone());
            assert!(
                matches!(json(&wide(&with_repeat)), Err(Error::DuplicateKey(_))),
                "repeat at {repeat_at}"
            );
        }
    }

    #[test]
    fn errors_leave_output_untouched() {
        let mut out = b"prefix".to_vec();
        let mut input = doc(&[(0x10, "a", vec![1, 0, 0, 0])]);
        input.extend(doc(&[(0x09, "when", vec![0; 8])]));
        assert!(transcode_docs(&input, &mut out).is_err());
        assert_eq!(out, b"prefix");
    }

    #[test]
    fn malformed_input_errors_without_panicking() {
        let d = doc(&[
            (0x02, "shape", bstr("polygon")),
            (0x04, "c", doc(&[(0x03, "0", doc(&[(0x01, "x", vec![0; 8])]))])),
            (0x07, "_id", vec![1; 12]),
        ]);
        // Every truncation, and every single-byte corruption at every
        // offset: each must return (Ok or Err), never panic or overrun.
        for cut in 0..d.len() {
            let _ = json(&d[..cut]);
        }
        for i in 0..d.len() {
            for b in [0u8, 1, 0x7f, 0x80, 0xff] {
                let mut m = d.clone();
                m[i] = b;
                let _ = json(&m);
            }
        }
        let nested = |levels| {
            let mut d = doc(&[]);
            for _ in 0..levels {
                d = doc(&[(0x03, "a", d)]);
            }
            d
        };
        assert!(json(&nested(MAX_DEPTH)).is_ok());
        assert!(matches!(
            json(&nested(MAX_DEPTH + 1)),
            Err(Error::Malformed("nesting too deep", _))
        ));
    }
}
