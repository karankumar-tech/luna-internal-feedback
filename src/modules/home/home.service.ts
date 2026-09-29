import { todayInZone } from '../../lib/time.js';
import type { CategoriesRepo } from '../categories/categories.repo.js';
import type { AttentionService } from '../attention/attention.service.js';
import type { HomeListFilters, HomeRepo } from './home.repo.js';

/** Categories the home page's graph can show: the page draws the top eight and expands to the rest. */
const CATEGORY_BARS = 40;
export const HOME_PAGE_SIZE = 25;

/**
 * The dashboard's home page in as few round trips as possible: one request carries the top numbers,
 * the category graph, the badge counts, the labels to print keys with, and the first page of issues.
 * Everything in it is the same for every viewer apart from "mine", so the page can show its last copy
 * instantly and refresh behind it.
 */
export class HomeService {
  constructor(
    private readonly repo: HomeRepo,
    private readonly deps: { categories: CategoriesRepo; attention: AttentionService; timeZone: string },
  ) {}

  today(): string {
    return todayInZone(this.deps.timeZone);
  }

  async overview(me: string | null) {
    const today = this.today();
    const [summary, categories, labels, counts, first] = await Promise.all([
      this.repo.summary(today),
      this.repo.categories(today, CATEGORY_BARS),
      this.deps.categories.labels(),
      this.deps.attention.counts({ is_test: false }, me),
      this.repo.reports({ is_test: false, is_positive: false }, today, 1, HOME_PAGE_SIZE),
    ]);
    return {
      generated_at: new Date().toISOString(),
      today,
      summary: {
        today: { issues: summary.today, cx: summary.today_cx },
        last_7_days: { issues: summary.week, cx: summary.week_cx, people: summary.week_people },
        previous_7_days: { issues: summary.prev_week },
      },
      /** Real issues received in the last 7 days, by category. A report can name several. */
      categories,
      labels,
      counts: { mine: counts.mine, untouched: counts.untouched, stale: counts.stale, cx_waiting: counts.cx_waiting },
      reports: { ...first, page: 1, page_size: HOME_PAGE_SIZE },
    };
  }

  async reports(filters: HomeListFilters, page: number, pageSize: number) {
    const out = await this.repo.reports(filters, this.today(), page, pageSize);
    return { ...out, page, page_size: pageSize };
  }
}
