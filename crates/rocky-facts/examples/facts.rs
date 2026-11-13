use std::env;
use std::fs;
use std::process;

use rocky_facts::{FileInput, Side, analyze, debug, snippet};

fn read_side(arg: &str) -> Result<Option<String>, String> {
    if arg == "-" {
        Ok(None)
    } else {
        fs::read_to_string(arg)
            .map(Some)
            .map_err(|err| format!("failed to read {arg}: {err}"))
    }
}

fn to_side(text: Option<&str>) -> Side<'_> {
    match text {
        Some(s) => Side::Text(s),
        None => Side::Absent,
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: facts <path> <before-file|-> <after-file|->");
        process::exit(2);
    }

    let path = &args[1];
    let before = match read_side(&args[2]) {
        Ok(text) => text,
        Err(msg) => {
            eprintln!("{msg}");
            process::exit(1);
        }
    };
    let after = match read_side(&args[3]) {
        Ok(text) => text,
        Err(msg) => {
            eprintln!("{msg}");
            process::exit(1);
        }
    };

    let input = FileInput {
        path,
        before: to_side(before.as_deref()),
        after: to_side(after.as_deref()),
    };

    let facts = analyze(&input);
    let json = serde_json::to_string_pretty(&facts).expect("serialize FileFacts");
    println!("{json}");

    for change in &facts.changes {
        let lines = snippet(&input, change.symbol.as_ref());
        println!();
        println!("{}", debug::render(change.symbol.as_ref(), &lines));
    }
}
