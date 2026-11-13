use crate::model::Lang;

const EXT_LANGS: &[(&str, Lang)] = &[
    ("ts", Lang::Typescript),
    ("mts", Lang::Typescript),
    ("cts", Lang::Typescript),
    ("tsx", Lang::Tsx),
    ("js", Lang::Javascript),
    ("mjs", Lang::Javascript),
    ("cjs", Lang::Javascript),
    ("jsx", Lang::Javascript),
    ("rs", Lang::Rust),
    ("json", Lang::Json),
    ("toml", Lang::Toml),
];

/// Classifies a file path into its `Lang` by exact basename first, then case-insensitive extension.
pub fn lang_for_path(path: &str) -> Lang {
    let basename = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match basename {
        "package-lock.json" | "Cargo.lock" | "pnpm-lock.yaml" | "yarn.lock" => {
            return Lang::Lockfile;
        }
        "package.json" => return Lang::PackageJson,
        "Cargo.toml" => return Lang::CargoToml,
        _ => {}
    }

    let Some((stem, ext)) = basename.rsplit_once('.') else {
        return Lang::Plain;
    };
    if stem.is_empty() {
        return Lang::Plain;
    }

    EXT_LANGS
        .iter()
        .find(|(candidate, _)| ext.eq_ignore_ascii_case(candidate))
        .map_or(Lang::Plain, |&(_, lang)| lang)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_table() {
        let cases = [
            ("src/a.ts", Lang::Typescript),
            ("a.mts", Lang::Typescript),
            ("a.cts", Lang::Typescript),
            ("A.TS", Lang::Typescript),
            (r"src\a.ts", Lang::Typescript),
            ("a.tsx", Lang::Tsx),
            ("a.js", Lang::Javascript),
            ("a.mjs", Lang::Javascript),
            ("a.cjs", Lang::Javascript),
            ("a.jsx", Lang::Javascript),
            ("x.rs", Lang::Rust),
            ("package.json", Lang::PackageJson),
            ("crates/a/Cargo.toml", Lang::CargoToml),
            ("tsconfig.json", Lang::Json),
            ("rustfmt.toml", Lang::Toml),
            ("package-lock.json", Lang::Lockfile),
            ("Cargo.lock", Lang::Lockfile),
            ("pnpm-lock.yaml", Lang::Lockfile),
            ("yarn.lock", Lang::Lockfile),
            ("README.md", Lang::Plain),
            ("Makefile", Lang::Plain),
        ];

        for (path, expected) in cases {
            assert_eq!(lang_for_path(path), expected, "path: {path}");
        }
    }

    #[test]
    fn lang_basename_matching() {
        assert_eq!(lang_for_path(r"sub\package-lock.json"), Lang::Lockfile);
        assert_eq!(lang_for_path("sub/my-package.json"), Lang::Json);
        assert_eq!(lang_for_path("CARGO.TOML"), Lang::Toml);
        assert_eq!(lang_for_path(".gitignore"), Lang::Plain);
        assert_eq!(lang_for_path(".eslintrc.json"), Lang::Json);
    }
}
