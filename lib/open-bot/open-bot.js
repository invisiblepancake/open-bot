const Github = require("./github");
const Config = require("./Config");
const Queue = require("promise-queue");
const once = require("./helpers/once");
const yaml = require("js-yaml");

function queueAll(queue, array, fn) {
	return Promise.all(array.map(item => queue.add(() => fn(item))));
}

class OpenBot {
	constructor(config) {
		this.config = config;
		this.github = new Github(config);
	}

	getRepo(owner, repo) {
		return this.github.getRepo(owner, repo);
	}

	getIssue(owner, repo, number) {
		return this.github.getIssue(owner, repo, number)
			.then(issue => this.getRepo(owner, repo).then(repo => {
				issue.repo = repo;
				return issue;
			}))
			.then(issue => {
				issue.type = "issue";
				issue.full_name = `${owner}/${repo}#${number}`;
				return issue;
			});
	}

	getReposOfOrg(org) {
		return this.github.getReposOfOrg(org);
	}

	getConfig(owner, repo) {
		let settingsJson;
		if(this.config.overrideSettings) {
			settingsJson = Promise.resolve(this.config.overrideSettings);
		} else {
			settingsJson = this.github.getBlob(owner, repo, "/open-bot.yaml")
				.then(blob => new Buffer(blob.content, "base64").toString("utf-8"))
				.then(content => yaml.safeLoad(content));
		}
		return settingsJson
			.then(config => new Config(config))
			.catch(err => {
				throw new Error(`Cannot read settings file in ${owner}/${repo}: ${err}`)
			});
	}

	process({ workItems, reporter = () => {}, simulate = false }) {
		const queue = new Queue(20);
		const FETCH_ACTION = "fetch config and issues";
		const PROCESS_ACTION = "process issue";
		workItems.forEach(({ full_name }) => reporter({
			item: full_name,
			action: FETCH_ACTION,
			change: "queued"
		}));
		return queueAll(queue, workItems, workItem => {
			reporter({
				item: workItem.full_name,
				action: FETCH_ACTION,
				change: "start"
			});
			if(workItem.type === "issue") {
				return this.getConfig(workItem.repo.owner.login, workItem.repo.name)
					.then(config => [{
						config,
						repo: workItem.repo,
						issue: workItem
					}]);
			}
			const repo = workItem;
			const config = this.getConfig(repo.owner.login, repo.name);
			return config
				.then(config => {
					if(config.bot !== this.config.user)
						throw new Error("Reject to process repo of different bot user (config.bot property)");
					return this.github.getIssuesForRepo(repo.owner.login, repo.name)
						.then(issues => {
							reporter({
								item: workItem.full_name,
								action: FETCH_ACTION,
								change: "done"
							});
							return issues.map(issue => ({
								config,
								repo,
								issue
							}));
						});
				})
				.catch(err => {
					reporter({
						item: workItem.full_name,
						error: "Failed to process work item: " + err,
						stack: err.stack
					});
					return [];
				});
		})
			.then(issuesLists => issuesLists.reduce((list, item) => list.concat(item), []))
			.then(issues => {
				issues.forEach(({ repo: { full_name }, issue: { number }}) => reporter({
					item: full_name + "#" + number,
					action: PROCESS_ACTION,
					change: "queued"
				}));
				return queueAll(queue, issues, ({ config, repo, issue }) => {
					reporter({
						item: repo.full_name + "#" + issue.number,
						action: PROCESS_ACTION,
						change: "start"
					});
					return this.processIssueWithData({
						config,
						owner: repo.owner.login,
						repo: repo.name,
						issue,
						reporter,
						simulate
					}).then(() => {
						reporter({
							item: repo.full_name + "#" + issue.number,
							action: PROCESS_ACTION,
							change: "done"
						});
					});
				});
			});
	}

	processIssue({ owner, repo, number, reporter = () => {}, simulate = false }) {
		return this.getConfig(owner, repo).catch(err => null).then(config => {
			if(!config) {
				reporter({
					item: `${owner}/${repo}#${number}`,
					action: "skip (no config)"
				});
				return;
			}
			if(config.bot !== this.config.user) {
				reporter({
					item: `${owner}/${repo}#${number}`,
					action: "skip (different bot user)"
				});
				return;
			}
			return this.github.getIssue(owner, repo, number).then(issue => {
				return this.processIssueWithData({ config, owner, repo, issue, reporter, simulate });
			});
		});
	}

	processIssueWithData({ config, owner, repo, issue, reporter = () => {}, simulate = false }) {
		Object.defineProperty(issue, "timeline", {
			get: once(() => this.github.getEventsForIssue(owner, repo, issue.number))
		});
		Object.defineProperty(issue, "comments", {
			get: once(() => this.github.getCommentsForIssue(owner, repo, issue.number))
		});
		Object.defineProperty(issue, "pull_request_info", {
			get: once(() => issue.pull_request ? this.github.getPullRequest(owner, repo, issue.number) : Promise.resolve(null))
		});
		Object.defineProperty(issue, "pull_request_commits", {
			get: once(() => issue.pull_request ? this.github.getCommitsForPullRequest(owner, repo, issue.number) : Promise.resolve([]))
		});
		Object.defineProperty(issue, "pull_request_reviews", {
			get: once(() => issue.pull_request ? this.github.getReviewsForPullRequest(owner, repo, issue.number) : Promise.resolve([]))
		});
		Object.defineProperty(issue, "pull_request_statuses", {
			get: once(() => {
				if(!issue.pull_request) return Promise.resolve([]);
				return issue.pull_request_info.then(info => {
					if(!info.head || !info.head.sha) return [];
					return this.github.getStatuses(owner, repo, info.head.sha)
						.then(statuses => statuses.reverse());
				});
			})
		});
		return config.run({
			owner,
			repo,
			item: `${owner}/${repo}#${issue.number}`,
			github: this.github,
			botUsername: this.config.user,
			data: {},
			reporter,
			simulate
		}, issue);
	}
}

module.exports = OpenBot;