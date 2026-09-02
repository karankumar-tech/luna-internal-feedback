-- Ring / band serial number, optional common field. Used to look up device logs (serial_no) before falling back to email.
alter table luna_feedback.submissions
  add column if not exists device_serial text
  constraint submissions_device_serial_len check (device_serial is null or char_length(device_serial) between 3 and 64);

create index if not exists submissions_device_serial_idx on luna_feedback.submissions (device_serial) where device_serial is not null;
