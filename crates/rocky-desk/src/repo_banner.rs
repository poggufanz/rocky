//! Where the "allow file history?" banner for a pending repo is drawn in the
//! Agents view. Pure: the render code only follows these places.

use rocky_proto::pipe::PendingRepo;

use crate::view::RepoGroup;

/// Where a pending repo's banner sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BannerPlace {
    /// On the group at this index of the groups list.
    Group(usize),
    /// Above all groups.
    Top,
}

/// Places every pending repo once: on the first group whose roots contain its
/// `main` or `key`, otherwise at the top. Windows paths compare without case.
pub fn banner_places(
    groups: &[RepoGroup],
    pending: &[PendingRepo],
) -> Vec<(BannerPlace, PendingRepo)> {
    places_with_case(groups, pending, cfg!(windows))
}

fn same_root(a: &str, b: &str, ignore_case: bool) -> bool {
    if ignore_case {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

fn places_with_case(
    groups: &[RepoGroup],
    pending: &[PendingRepo],
    ignore_case: bool,
) -> Vec<(BannerPlace, PendingRepo)> {
    pending
        .iter()
        .map(|repo| {
            let place = groups
                .iter()
                .position(|g| {
                    g.roots.iter().any(|root| {
                        same_root(root, &repo.main, ignore_case)
                            || same_root(root, &repo.key, ignore_case)
                    })
                })
                .map_or(BannerPlace::Top, BannerPlace::Group);
            (place, repo.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(name: &str, roots: &[&str]) -> RepoGroup {
        RepoGroup {
            name: name.to_string(),
            branch: None,
            roots: roots.iter().map(|r| r.to_string()).collect(),
            sessions: Vec::new(),
        }
    }

    fn repo(key: &str, main: &str) -> PendingRepo {
        PendingRepo {
            key: key.to_string(),
            main: main.to_string(),
            name: "demo".to_string(),
        }
    }

    #[test]
    fn banner_goes_to_matching_group() {
        let groups = vec![group("a", &["/work/a"]), group("b", &["/work/b"])];
        let placed = places_with_case(&groups, &[repo("/work/b", "/work/b")], false);
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].0, BannerPlace::Group(1));
        let by_key = places_with_case(&groups, &[repo("/work/a", "/other")], false);
        assert_eq!(by_key[0].0, BannerPlace::Group(0));
    }

    #[test]
    fn worktree_session_without_match_goes_top() {
        let groups = vec![group("a", &["/work/a-worktree"])];
        let placed = places_with_case(&groups, &[repo("/work/a", "/work/a")], false);
        assert_eq!(placed[0].0, BannerPlace::Top);
        assert!(banner_places(&[], &[repo("k", "m")])[0].0 == BannerPlace::Top);
    }

    #[test]
    fn case_match_follows_platform() {
        let groups = vec![group("a", &["C:\\Work\\A"])];
        let pending = [repo("c:\\work\\a", "c:\\work\\a")];
        assert_eq!(
            places_with_case(&groups, &pending, true)[0].0,
            BannerPlace::Group(0)
        );
        assert_eq!(
            places_with_case(&groups, &pending, false)[0].0,
            BannerPlace::Top
        );
    }

    #[test]
    fn answered_repo_has_no_banner() {
        let groups = vec![group("a", &["/work/a"])];
        assert!(banner_places(&groups, &[]).is_empty());
    }
}
