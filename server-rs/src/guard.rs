//! Other websites can send requests to localhost from your browser, and these routes hold your keys and run MCP tools.
//! Only this app, on this machine, gets through. This also means the app can't be used once deployed, on purpose.
use axum::http::HeaderMap;

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

pub fn is_local_request(headers: &HeaderMap) -> bool {
    let host = header(headers, "host").unwrap_or("");
    // `:3000` is dropped; also stops DNS rebinding.
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    if !["localhost", "127.0.0.1", "[::1]"].contains(&name) {
        return false;
    }
    if let Some(origin) = header(headers, "origin").filter(|o| !o.is_empty()) {
        if origin != format!("http://{host}") && origin != format!("https://{host}") {
            return false;
        }
    }
    matches!(header(headers, "sec-fetch-site"), None | Some("") | Some("same-origin") | Some("none"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(pairs: &[(&str, &str)]) -> bool {
        let mut headers = HeaderMap::new();
        for (k, v) in pairs {
            headers.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        is_local_request(&headers)
    }

    #[test]
    fn this_app_on_this_machine_gets_through() {
        assert!(ask(&[("host", "localhost:3000"), ("origin", "http://localhost:3000"), ("sec-fetch-site", "same-origin")]));
        assert!(ask(&[("host", "127.0.0.1:3000")]));
        assert!(ask(&[("host", "[::1]:3000")]));
    }

    #[test]
    fn other_sites_and_other_hosts_dont() {
        assert!(!ask(&[("host", "localhost:3000"), ("origin", "https://evil.example"), ("sec-fetch-site", "cross-site")]));
        assert!(!ask(&[("host", "localhost:3000"), ("sec-fetch-site", "cross-site")]));
        assert!(!ask(&[("host", "evil.example")]));
        assert!(!ask(&[("host", "capri.example.com"), ("origin", "https://capri.example.com")]));
        assert!(!ask(&[]));
    }
}
